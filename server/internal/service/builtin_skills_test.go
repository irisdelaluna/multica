package service

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/util"
	"gopkg.in/yaml.v3"
)

// Built-in skills are the platform's standard "template" skills. These evals
// pin the template every skill must follow and — crucially — couple each
// skill's documented contract to the real backend behavior it describes, so a
// drift in the source-of-truth (e.g. the mention regex) breaks CI instead of
// silently turning the skill into a lie agents act on.
//
// The evals live in a _test.go file on purpose: anything *inside* a skill
// directory is walked into AgentSkillData.Files and shipped to agent machines
// (see loadBuiltinSkill). Tests must stay out of that payload.

const (
	// maxSkillBodyLines is Anthropic's L2 budget for a SKILL.md body
	// (~5k tokens). Past this, content belongs in one-level-deep supporting
	// files, not the always-loaded body.
	maxSkillBodyLines = 500
	// maxDescriptionChars is the frontmatter description cap — it is the only
	// thing an agent sees when deciding whether to load the skill.
	maxDescriptionChars = 1024
)

// TestBuiltinSkillsConformToTemplate enforces the standard-template invariants
// on every built-in skill, current and future. A new skill that violates the
// shape fails here without anyone having to remember the rules.
func TestBuiltinSkillsConformToTemplate(t *testing.T) {
	skills := loadBuiltinSkills()
	if len(skills) == 0 {
		t.Fatal("no built-in skills loaded; embed or layout is broken")
	}

	for _, skill := range skills {
		t.Run(skill.Name, func(t *testing.T) {
			// The multica- prefix keeps the on-disk slug from colliding with a
			// user-authored workspace skill.
			if !strings.HasPrefix(skill.Name, "multica-") {
				t.Errorf("skill name %q must carry the multica- prefix", skill.Name)
			}

			fm, body, ok := splitFrontmatter(skill.Content)
			if !ok {
				t.Fatalf("SKILL.md must lead with a --- frontmatter block")
			}
			if strings.TrimSpace(fm["name"]) == "" {
				t.Errorf("frontmatter is missing a non-empty name")
			}
			desc := strings.TrimSpace(fm["description"])
			if desc == "" {
				t.Errorf("frontmatter is missing a description (the only thing an agent sees when deciding to load the skill)")
			}
			if skill.Description != desc {
				t.Errorf("loaded description does not match frontmatter")
			}
			if len(desc) > maxDescriptionChars {
				t.Errorf("description is %d chars, over the %d cap", len(desc), maxDescriptionChars)
			}
			if n := strings.Count(body, "\n") + 1; n > maxSkillBodyLines {
				t.Errorf("SKILL.md body is %d lines, over the %d-line L2 budget; move detail into one-level-deep supporting files", n, maxSkillBodyLines)
			}

			// Evals must never ride along to agent machines as supporting files.
			for _, f := range skill.Files {
				lower := strings.ToLower(f.Path)
				if strings.Contains(lower, "eval") || strings.HasSuffix(lower, "_test.go") || strings.HasSuffix(lower, "_test.md") {
					t.Errorf("supporting file %q looks like an eval/test; evals belong in _test.go, not the shipped skill payload", f.Path)
				}
			}
		})
	}
}

// TestBuiltinSkillsFrontmatterIsStrictYAML is the regression guard for MUL-3100
// / GitHub #3851: a built-in SKILL.md whose frontmatter is not valid YAML 1.2
// (the canonical break is an unquoted `: ` inside the description) is silently
// dropped by strict runtimes like Codex, so the agent runs without that
// platform-contract skill.
//
// This check is deliberately separate from TestBuiltinSkillsConformToTemplate:
// that test reads the frontmatter through splitFrontmatter, a naive line parser
// that splits on the first ':' and never runs a YAML parse — so it passes even
// on the broken files. Only a real yaml.Unmarshal reproduces what Codex does,
// which is exactly what is needed to catch this class of bug before it ships.
func TestBuiltinSkillsFrontmatterIsStrictYAML(t *testing.T) {
	skills := loadBuiltinSkills()
	if len(skills) == 0 {
		t.Fatal("no built-in skills loaded; embed or layout is broken")
	}

	for _, skill := range skills {
		t.Run(skill.Name, func(t *testing.T) {
			content := skill.Content
			if !strings.HasPrefix(content, "---\n") {
				t.Fatalf("SKILL.md must lead with a --- frontmatter block")
			}
			rest := content[len("---\n"):]
			end := strings.Index(rest, "\n---")
			if end < 0 {
				t.Fatalf("frontmatter has no closing --- delimiter")
			}

			var fm map[string]any
			if err := yaml.Unmarshal([]byte(rest[:end]), &fm); err != nil {
				t.Fatalf("frontmatter is not valid YAML — a strict runtime (e.g. Codex) "+
					"will drop this skill on load; quote values containing ': ': %v", err)
			}

			if name, ok := fm["name"].(string); !ok || strings.TrimSpace(name) == "" {
				t.Errorf("frontmatter name must parse as a non-empty string, got %#v", fm["name"])
			}
			if desc, ok := fm["description"].(string); !ok || strings.TrimSpace(desc) == "" {
				t.Errorf("frontmatter description must parse as a non-empty string, got %#v", fm["description"])
			}
		})
	}
}

// TestMentioningSkillFollowsContractFrontmatter locks the reference template:
// the mentioning skill is a context-triggered platform-contract skill, so it
// must declare user-invocable:false and fence itself to the multica CLI. New
// contract skills should copy this shape.
func TestMentioningSkillFollowsContractFrontmatter(t *testing.T) {
	skill, ok := findSkill(t, "multica-mentioning")
	if !ok {
		return
	}
	fm, _, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (a platform-contract skill triggers from context, not a slash command)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); got != "Bash(multica *)" {
		t.Errorf("allowed-tools = %q, want Bash(multica *) (fence the skill to the CLI it teaches)", got)
	}
}

// TestMentioningSkillTeachesTheParserContract is the eval that gives the skill
// its value: it proves the skill teaches exactly what util.ParseMentions
// enforces. The skill's "Incorrect" examples must parse to nothing (the
// @gpt-boy class of bug: a name where a UUID belongs fails silently), and its
// "Correct" example must parse. If mention.go:16 drifts, this breaks and the
// skill's claims must be re-checked.
func TestMentioningSkillTeachesTheParserContract(t *testing.T) {
	const uuid = "7f3a1b2c-0000-4000-8000-000000000abc"

	cases := []struct {
		name    string
		content string
		want    []util.Mention
	}{
		{
			// Skill: "Writing [@Alice](mention://member/Alice) does NOTHING."
			// 'l'/'i' are not hex, so the id fails to parse — link is dead.
			name:    "name where a uuid belongs is silently dead",
			content: "[@Alice](mention://member/Alice) please review",
			want:    nil,
		},
		{
			// Skill: a bare @name is plain text, nobody is notified.
			name:    "bare @name is plain text",
			content: "@alice please review",
			want:    nil,
		},
		{
			// Skill Step 2: type and id source matched → fires.
			name:    "real uuid with matching type fires",
			content: "[@Alice](mention://member/" + uuid + ") please review",
			want:    []util.Mention{{Type: "member", ID: uuid}},
		},
		{
			// Skill: @all uses the literal `all`, never a UUID.
			name:    "all uses the literal all",
			content: "[@all](mention://all/all) heads up",
			want:    []util.Mention{{Type: "all", ID: "all"}},
		},
		{
			// Skill: "Using the wrong type for an id points at the wrong
			// entity." The link still parses — it just resolves wrong — which
			// is exactly why the skill stresses matching type to id source.
			name:    "wrong type still parses (points at wrong entity)",
			content: "[@Bot](mention://member/" + uuid + ")",
			want:    []util.Mention{{Type: "member", ID: uuid}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := util.ParseMentions(tc.content)
			if len(got) != len(tc.want) {
				t.Fatalf("ParseMentions(%q) = %+v, want %+v", tc.content, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("mention[%d] = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestWorkingOnIssuesSkillCoversIssueLoopContracts(t *testing.T) {
	skill, ok := findSkill(t, "multica-working-on-issues")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (issue workflow guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	// Contract anchors only — exact file:line citations live in the skill's
	// references/source-map.md, not here, so a downstream main merge that
	// shifts a line cannot rot this test into pinning a stale lie.
	mustContain := []string{
		"multica issue pull-requests <issue-id> --output json",
		"Default for code-changing issue work",
		"open or update a PR before posting the final Multica issue comment",
		"This is a default, not",
		"Use a routable issue key in the PR title, body, or branch",
		"include the PR URL when a PR exists",
		"Closes MUL-2759",
		"--status backlog",
		"pr_url",
		"references/working-on-issues-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("working-on-issues skill missing %q", want)
		}
	}

	mustNotContain := []string{
		"Start from the trigger, not from memory",
		"multica issue get <issue-id> --output json",
		"multica issue metadata list <issue-id> --output json",
		"multica issue comment list <issue-id> --thread <trigger-comment-id>",
		"multica issue comment add <issue-id> --parent <trigger-comment-id>",
	}
	for _, forbidden := range mustNotContain {
		if strings.Contains(body, forbidden) {
			t.Errorf("working-on-issues skill duplicates runtime prompt contract %q", forbidden)
		}
	}

	if !skillHasFile(skill, "references/working-on-issues-source-map.md") {
		t.Errorf("working-on-issues skill missing supporting file references/working-on-issues-source-map.md")
	}
}

func TestSkillImportingSkillCoversWorkspaceImportContracts(t *testing.T) {
	skill, ok := findSkill(t, "multica-skill-importing")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (skill import guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"multica skill import --url <url> --output json",
		"/api/skills/import",
		"clawhub.ai",
		"skills.sh",
		"github.com",
		"config.origin",
		"--on-conflict fail",
		"--on-conflict overwrite",
		"--on-conflict rename",
		"--on-conflict skip",
		"status",
		"conflict",
		"skipped",
		"409",
		"existing_skill",
		"id",
		"name",
		"legacy",
		"multica skill list --output json",
		"npx skills add",
		"multica agent skills add <agent-id> --skill-ids <skill-id> --output json",
		"multica agent skills list <agent-id> --output json",
		"replace-all",
		"`set` is the replacement path",
		"references/skill-importing-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("skill-importing skill missing %q", want)
		}
	}

	mustNotContain := []string{
		"multica agent skills set <agent-id> --skill-ids <skill-id>",
		"merge the new skill id with the existing ids",
	}
	for _, forbidden := range mustNotContain {
		if strings.Contains(body, forbidden) {
			t.Errorf("skill-importing skill should not teach stale or destructive binding command %q", forbidden)
		}
	}

	if !skillHasFile(skill, "references/skill-importing-source-map.md") {
		t.Errorf("skill-importing skill missing supporting file references/skill-importing-source-map.md")
	}
}

func TestCreatingAgentsSkillCoversAgentCreationContracts(t *testing.T) {
	skill, ok := findSkill(t, "multica-creating-agents")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (agent creation guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"not a parameter manual",
		"`description` is a catalog summary",
		"`instructions` is the runtime behavior contract",
		"`avatar_url` → a random `emoji:<glyph>`",
		"multica agent create --name <name> --runtime-id <runtime-id>",
		"`model` is a first-class persisted column",
		"custom_env",
		"--custom-env-stdin",
		"--custom-env-file",
		"multica agent skills add <agent-id> --skill-ids <skill-id> --output json",
		"multica agent skills list <agent-id> --output json",
		"multica agent get <agent-id> --output json",
		"255",
		"references/creating-agents-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("creating-agents skill missing %q", want)
		}
	}

	mustNotContain := []string{
		"--from-template",
		"/api/agent-templates",
		"template_slug",
		"curated template",
		"copy this parameter list",
		// De-coaching: this skill states source-backed contracts, it does not
		// teach a generic how-to methodology.
		"Define the job first",
		"Run a low-risk task",
		"Decision flow",
	}
	for _, forbidden := range mustNotContain {
		if strings.Contains(body, forbidden) {
			t.Errorf("creating-agents skill should not teach immature template content or generic how-to coaching %q", forbidden)
		}
	}

	if !skillHasFile(skill, "references/creating-agents-source-map.md") {
		t.Errorf("creating-agents skill missing supporting file references/creating-agents-source-map.md")
	}
}

func TestSquadsSkillCoversLeaderRoutingContract(t *testing.T) {
	skill, ok := findSkill(t, "multica-squads")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (squad guidance triggers from context)", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"A squad is not an agent",
		"squad's `leader_id` agent",
		"squad members are not automatically fanned out",
		"multica squad member set-role",
		"mention://squad/<squad-id>",
		"recording squad activity",
		"references/squad-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("squads skill missing %q", want)
		}
	}

	if !skillHasFile(skill, "references/squad-source-map.md") {
		t.Errorf("squads skill missing supporting file references/squad-source-map.md")
	}
}

func TestAutopilotsSkillCoversDispatchAndSideEffects(t *testing.T) {
	skill, ok := findSkill(t, "multica-autopilots")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"An autopilot is not an agent",
		"create_issue",
		"run_only",
		"multica autopilot trigger-add <autopilot-id> --kind schedule",
		"multica autopilot trigger <autopilot-id> --output json",
		"Do not run `trigger`",
		"webhook tokens",
		"{{date}}",
		"squad's leader agent",
		"references/autopilots-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("autopilots skill missing %q", want)
		}
	}
	if !skillHasFile(skill, "references/autopilots-source-map.md") {
		t.Errorf("autopilots skill missing supporting file references/autopilots-source-map.md")
	}
}

func TestRuntimesAndReposSkillCoversClaimAndCheckoutChain(t *testing.T) {
	skill, ok := findSkill(t, "multica-runtimes-and-repos")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"agent_task_queue",
		"daemon polls/claims the task",
		"multica runtime list --output json",
		"multica repo checkout <url>",
		"MULTICA_DAEMON_PORT",
		"resource_ref.ref",
		"github_repo",
		"local_directory",
		"Runtime and repo commands affect active agent execution",
		"references/runtimes-and-repos-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("runtimes-and-repos skill missing %q", want)
		}
	}
	if !skillHasFile(skill, "references/runtimes-and-repos-source-map.md") {
		t.Errorf("runtimes-and-repos skill missing supporting file references/runtimes-and-repos-source-map.md")
	}
}

func TestProjectsAndResourcesSkillCoversDurableContext(t *testing.T) {
	skill, ok := findSkill(t, "multica-projects-and-resources")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false", got)
	}
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "Bash(multica *)") {
		t.Errorf("allowed-tools = %q, want access to the Multica CLI", got)
	}

	mustContain := []string{
		"Projects are durable context containers",
		".multica/project/resources.json",
		"multica project resource list <project-id> --output json",
		"multica project resource add <project-id> --type github_repo --url <github-url> --output json",
		"multica project resource add <project-id> --type github_repo --url <github-url> --ref <branch-or-sha> --output json",
		"multica project resource add <project-id> --type local_directory",
		"Project resources are durable and affect future tasks",
		"github_repo.resource_ref.url",
		"resource_ref.ref",
		"references/projects-and-resources-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("projects-and-resources skill missing %q", want)
		}
	}
	if !skillHasFile(skill, "references/projects-and-resources-source-map.md") {
		t.Errorf("projects-and-resources skill missing supporting file references/projects-and-resources-source-map.md")
	}
}

// TestMuninnMemorySkillCoversRecallRememberDiscipline pins the
// multica-muninn-memory skill. Unlike the other contract skills it documents
// an external MCP server (MuninnDB), so it fences its tools to the muninn MCP
// server rather than the multica CLI. The eval anchors the two-vault
// architecture (personal vault read-write, shared vault read-only), the four
// required disciplines (recall at start; atomic remember at end; evolve over
// forget+remember; link related), and the personal-vault discipline (Quiet
// Scribe is the sole writer to the shared vault; divergence between agents'
// vaults is signal, not error) without over-pinning the exact per-runtime MCP
// tool-name glob — the meaningful, stable contract is that the fence targets
// the muninn server, finalized when the overlay injects it.
func TestMuninnMemorySkillCoversRecallRememberDiscipline(t *testing.T) {
	skill, ok := findSkill(t, "multica-muninn-memory")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (memory discipline triggers from context)", got)
	}
	// This is the first MCP-discipline skill: its tool fence targets the
	// muninn MCP server, not Bash(multica *). Assert the stable server
	// identity; the exact glob suffix is runtime-dependent.
	if got := strings.TrimSpace(fm["allowed-tools"]); !strings.Contains(got, "mcp__muninn") {
		t.Errorf("allowed-tools = %q, want the fence to target the muninn MCP server (mcp__muninn)", got)
	}

	mustContain := []string{
		"MuninnDB",
		"`multica`",
		"multica-<agent-slug>",
		"personal vault",
		"Read-only",
		"Quiet Scribe",
		"never write",
		"signal, not",
		"muninn_where_left_off",
		"muninn_recall",
		"scoped",
		"One",
		"concept per memory",
		"muninn_remember",
		"muninn_remember_batch",
		"muninn_evolve",
		"is the update path",
		"forget + remember",
		"muninn_link",
		"muninn_guide",
		"references/muninn-memory-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("muninn-memory skill missing %q", want)
		}
	}

	// This is an MCP-discipline skill, not a CLI skill: the body must not
	// fence itself to the multica CLI.
	mustNotContain := []string{
		"Bash(multica *)",
	}
	for _, forbidden := range mustNotContain {
		if strings.Contains(body, forbidden) {
			t.Errorf("muninn-memory skill should not fence to the multica CLI %q", forbidden)
		}
	}

	if !skillHasFile(skill, "references/muninn-memory-source-map.md") {
		t.Errorf("muninn-memory skill missing supporting file references/muninn-memory-source-map.md")
	}
}

// TestCodebaseOrientationSkillCoversRepoMap pins the multica-codebase-
// orientation skill — the shared floor every agent holds so any idle agent can
// take any issue. Unlike the CLI/MCP contract skills, this one is pure
// orientation: it fences to the repo's build/VCS tooling, not the multica CLI,
// and it carries stable structural anchors (directory names, make targets,
// config files) rather than file:line citations that rot on every commit.
// The companion TestCodebaseOrientationSkillClaimsAreReal checks each anchor
// against the live tree, so a restructuring that makes the skill a lie breaks
// CI here.
func TestCodebaseOrientationSkillCoversRepoMap(t *testing.T) {
	skill, ok := findSkill(t, "multica-codebase-orientation")
	if !ok {
		return
	}
	fm, body, _ := splitFrontmatter(skill.Content)

	if got := strings.TrimSpace(fm["user-invocable"]); got != "false" {
		t.Errorf("user-invocable = %q, want false (orientation triggers from context)", got)
	}
	// This skill orients work in the repo — it teaches make/pnpm/go/git/gh, not
	// the multica CLI. Assert the build/VCS tool families are present.
	for _, tool := range []string{"Bash(make *)", "Bash(pnpm *)", "Bash(go *)", "Bash(git *)"} {
		if !strings.Contains(fm["allowed-tools"], tool) {
			t.Errorf("allowed-tools %q missing %q (orientation covers the repo's build/VCS tooling)", fm["allowed-tools"], tool)
		}
	}

	mustContain := []string{
		// Where things live — the area map.
		"server/internal/handler",
		"server/internal/service",
		"server/pkg/db/queries",
		"server/pkg/db/generated",
		"server/migrations",
		"packages/core",
		"packages/views",
		"packages/ui",
		"apps/web",
		"apps/desktop",
		"contract/maps",
		// Run and check — the make/pnpm surface.
		"make dev",
		"make check",
		"make test",
		"make sqlc",
		"make worktree-env",
		".env.worktree",
		"Node 22",
		"Playwright",
		// The hard, non-obvious rules.
		"foreign key",
		"CONCURRENTLY",
		"parseWithFallback",
		"iris",
		// Pointers to depth, not restatement.
		"multica-muninn-memory",
		"multica-working-on-issues",
		"CLAUDE.md",
		"references/codebase-orientation-source-map.md",
	}
	for _, want := range mustContain {
		if !strings.Contains(body, want) {
			t.Errorf("codebase-orientation skill missing %q", want)
		}
	}

	// A skill-as-map must not carry file:line citations in the always-loaded
	// body — they rot on every commit. Depth lives in the source map and
	// contract/maps, cited there. Source-language line refs are the tell.
	lineCitation := regexp.MustCompile(`\.(go|ts|tsx|sql|py|hs):\d+`)
	if lineCitation.MatchString(body) {
		t.Errorf("codebase-orientation body contains a file:line citation; move it to the source map, not the body")
	}

	if !skillHasFile(skill, "references/codebase-orientation-source-map.md") {
		t.Errorf("codebase-orientation skill missing supporting file references/codebase-orientation-source-map.md")
	}
}

// TestCodebaseOrientationSkillClaimsAreReal is the eval that gives the skill its
// value: every structural claim — a path, a make target, a config file — is
// checked against the live repository, so the skill fails CI the moment it
// describes a layout that no longer exists. It resolves the repo root from the
// test file's own location (not the process cwd, which varies), then walks the
// claimed tree. File:line is intentionally not pinned (rots on every commit);
// these are structural anchors that change only on real restructuring.
func TestCodebaseOrientationSkillClaimsAreReal(t *testing.T) {
	root := repoRoot(t)

	for _, rel := range []string{
		// server/ layout the skill maps.
		"server",
		"server/internal/handler",
		"server/internal/service",
		"server/pkg/db/queries",
		"server/pkg/db/generated",
		"server/migrations",
		"server/cmd",
		// Monorepo packages with hard boundaries.
		"packages/core",
		"packages/ui",
		"packages/views",
		// App shells.
		"apps/web",
		"apps/desktop",
		"apps/mobile",
		// Depth reference.
		"contract/maps",
	} {
		if !dirExists(filepath.Join(root, rel)) {
			t.Errorf("skill claims %q exists, but it does not — update the skill (or the repo)", rel)
		}
	}

	for _, rel := range []string{
		"CLAUDE.md",
		"AGENTS.md",
		"server/go.mod",
		"server/sqlc.yaml",
		"apps/mobile/CLAUDE.md",
		".github/workflows/ci.yml",
	} {
		if !fileExists(filepath.Join(root, rel)) {
			t.Errorf("skill claims file %q exists, but it does not — update the skill (or the repo)", rel)
		}
	}

	// The five contract/maps files the skill names.
	maps, err := os.ReadDir(filepath.Join(root, "contract", "maps"))
	if err != nil {
		t.Fatalf("contract/maps unreadable: %v", err)
	}
	have := map[string]bool{}
	for _, e := range maps {
		have[e.Name()] = true
	}
	for _, name := range []string{"api.md", "api-shape-conventions.md", "realtime.md", "storage.md", "agent-pipeline.md"} {
		if !have[name] {
			t.Errorf("skill names contract/maps/%s, but it is absent", name)
		}
	}

	// Make targets the skill teaches must actually be declared.
	makefile, err := os.ReadFile(filepath.Join(root, "Makefile"))
	if err != nil {
		t.Fatalf("Makefile unreadable: %v", err)
	}
	makefileStr := string(makefile)
	for _, target := range []string{"dev:", "start:", "stop:", "check:", "test:", "sqlc:", "migrate-up:", "worktree-env:"} {
		if !strings.Contains(makefileStr, target) {
			t.Errorf("skill teaches `make %s`, but the Makefile does not declare target %q", strings.TrimSuffix(target, ":"), target)
		}
	}

	// The toolchain pins the skill states.
	ci, err := os.ReadFile(filepath.Join(root, ".github", "workflows", "ci.yml"))
	if err != nil {
		t.Fatalf("ci.yml unreadable: %v", err)
	}
	if !strings.Contains(string(ci), "node-version: 22") {
		t.Errorf("skill claims CI pins Node 22, but ci.yml does not contain 'node-version: 22'")
	}
	goMod, err := os.ReadFile(filepath.Join(root, "server", "go.mod"))
	if err != nil {
		t.Fatalf("server/go.mod unreadable: %v", err)
	}
	if !strings.Contains(string(goMod), "go 1.26.1") {
		t.Errorf("skill claims Go 1.26.1, but server/go.mod does not state it")
	}

	// The sqlc layout the skill describes.
	sqlcCfg, err := os.ReadFile(filepath.Join(root, "server", "sqlc.yaml"))
	if err != nil {
		t.Fatalf("sqlc.yaml unreadable: %v", err)
	}
	for _, fragment := range []string{"pkg/db/queries", "pkg/db/generated", "migrations/"} {
		if !strings.Contains(string(sqlcCfg), fragment) {
			t.Errorf("skill describes sqlc config with %q, but sqlc.yaml lacks it", fragment)
		}
	}

	// The hard rules the skill restates must still live in the authority it
	// points at (CLAUDE.md). If a rule moves out of CLAUDE.md, the skill's
	// "CLAUDE.md is the authority" claim becomes a lie.
	claudemd, err := os.ReadFile(filepath.Join(root, "CLAUDE.md"))
	if err != nil {
		t.Fatalf("CLAUDE.md unreadable: %v", err)
	}
	claudeStr := string(claudemd)
	for _, rule := range []string{"foreign key", "CONCURRENTLY", "parseWithFallback"} {
		if !strings.Contains(claudeStr, rule) {
			t.Errorf("skill says CLAUDE.md is the authority for %q, but CLAUDE.md no longer states it", rule)
		}
	}
}

// repoRoot locates the repository root from the test file's own path, walking up
// until it finds a directory that holds both Makefile and server/go.mod. It does
// not depend on the process working directory, which varies between `go test`,
// editor integrations, and CI.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed; cannot locate repo root")
	}
	dir := filepath.Dir(thisFile)
	for i := 0; i < 8; i++ {
		if fileExists(filepath.Join(dir, "Makefile")) && fileExists(filepath.Join(dir, "server", "go.mod")) {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("could not locate repo root (Makefile + server/go.mod) above the test file")
	return ""
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func findSkill(t *testing.T, name string) (AgentSkillData, bool) {
	t.Helper()
	for _, s := range loadBuiltinSkills() {
		if s.Name == name {
			return s, true
		}
	}
	t.Errorf("built-in skill %q not found", name)
	return AgentSkillData{}, false
}

func skillHasFile(skill AgentSkillData, path string) bool {
	for _, f := range skill.Files {
		if f.Path == path {
			return true
		}
	}
	return false
}

// splitFrontmatter returns the top-level scalar keys of a leading YAML
// frontmatter block, the body after it, and whether a block was found. It only
// understands flat `key: value` lines — enough for the template's frontmatter.
func splitFrontmatter(content string) (map[string]string, string, bool) {
	if !strings.HasPrefix(content, "---\n") {
		return nil, content, false
	}
	rest := content[len("---\n"):]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return nil, content, false
	}
	block := rest[:end]
	body := rest[end:]
	if nl := strings.Index(body, "\n"); nl >= 0 {
		body = body[nl+1:] // drop the closing --- line
	}

	fm := make(map[string]string)
	for _, line := range strings.Split(block, "\n") {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue // nested value; the template uses only flat scalars
		}
		key, val, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fm[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(val), `"'`)
	}
	return fm, body, true
}
