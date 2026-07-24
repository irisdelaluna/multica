package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ---------------------------------------------------------------------------
// POST /api/ask (IRI-76)
//
// The contract these tests protect is "an answer or a fast, explicit failure":
// every non-answer path must return a distinguishable status so a caller can
// decide in one step whether to retry, fall back to a comment thread, or give
// up — never a hang and never a silent empty string.
// ---------------------------------------------------------------------------

// decodeAskResponse reads a successful ask payload out of the recorder.
func decodeAskResponse(t *testing.T, rec *httptest.ResponseRecorder) askResponse {
	t.Helper()
	var resp askResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode ask response: %v (body=%s)", err, rec.Body.String())
	}
	return resp
}

func TestAskExpert_ReturnsAnswerFromExpert(t *testing.T) {
	requireDB(t)
	withStubLLM(t, stubLLMCompletion(t, http.StatusOK, "  Use --ref; it wins over the project default.  "))

	expertID := uuidToString(chatTitleTestAgentID(t))
	rec := httptest.NewRecorder()
	testHandler.AskExpert(rec, newRequest(http.MethodPost, "/api/ask", map[string]string{
		"expert":   expertID,
		"question": "Which flag pins the branch on repo checkout?",
	}))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	resp := decodeAskResponse(t, rec)
	// Trimmed, not reformatted: the answer must survive round-trip verbatim
	// apart from surrounding whitespace.
	if resp.Answer != "Use --ref; it wins over the project default." {
		t.Fatalf("unexpected answer %q", resp.Answer)
	}
	if resp.ExpertID != expertID {
		t.Fatalf("expected expert_id %q, got %q", expertID, resp.ExpertID)
	}
	if strings.TrimSpace(resp.ExpertName) == "" {
		t.Fatal("expected the expert name to be attributed on the answer")
	}
	if strings.TrimSpace(resp.Model) == "" {
		t.Fatal("expected the answering model to be reported")
	}
}

// A blank completion is a non-answer. Returning it as a 200 would let a caller
// act on an empty string as if the expert had spoken.
func TestAskExpert_EmptyCompletionIsAnError(t *testing.T) {
	requireDB(t)
	withStubLLM(t, stubLLMCompletion(t, http.StatusOK, "   \n  "))

	rec := httptest.NewRecorder()
	testHandler.AskExpert(rec, newRequest(http.MethodPost, "/api/ask", map[string]string{
		"expert":   uuidToString(chatTitleTestAgentID(t)),
		"question": "Does a repo checkout helper already exist?",
	}))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 for an empty answer, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestAskExpert_UpstreamFailureIsBadGateway(t *testing.T) {
	requireDB(t)
	withStubLLM(t, stubLLMCompletion(t, http.StatusInternalServerError, ""))

	rec := httptest.NewRecorder()
	testHandler.AskExpert(rec, newRequest(http.MethodPost, "/api/ask", map[string]string{
		"expert":   uuidToString(chatTitleTestAgentID(t)),
		"question": "Which make target runs the worktree checks?",
	}))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when the upstream fails, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestAskExpert_UnknownExpertIsNotFound(t *testing.T) {
	requireDB(t)
	withStubLLM(t, stubLLMCompletion(t, http.StatusOK, "never reached"))

	rec := httptest.NewRecorder()
	testHandler.AskExpert(rec, newRequest(http.MethodPost, "/api/ask", map[string]string{
		"expert":   "00000000-0000-0000-0000-000000000000",
		"question": "Anyone home?",
	}))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown expert, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// Validation runs before expert resolution, so these need neither a database
// nor a configured expert — only an enabled LLM layer to get past the 503 gate.
func TestAskExpert_RejectsMalformedRequests(t *testing.T) {
	requireDB(t)
	withStubLLM(t, stubLLMCompletion(t, http.StatusOK, "never reached"))

	cases := []struct {
		name string
		body map[string]string
	}{
		{"missing question", map[string]string{"expert": "00000000-0000-0000-0000-000000000001"}},
		{"blank question", map[string]string{"expert": "00000000-0000-0000-0000-000000000001", "question": "   "}},
		{"missing expert", map[string]string{"question": "Where does the daemon write task context?"}},
		{
			"oversized question",
			map[string]string{
				"expert":   "00000000-0000-0000-0000-000000000001",
				"question": strings.Repeat("x", askMaxQuestionLen+1),
			},
		},
		{
			"oversized context",
			map[string]string{
				"expert":   "00000000-0000-0000-0000-000000000001",
				"question": "short question",
				"context":  strings.Repeat("y", askMaxContextLen+1),
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			testHandler.AskExpert(rec, newRequest(http.MethodPost, "/api/ask", tc.body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d (body=%s)", rec.Code, rec.Body.String())
			}
		})
	}
}

// A deployment with no LLM layer must say so out loud. Chat titles degrade
// silently; an unanswered question cannot, or the caller waits on nothing.
func TestAskExpert_UnconfiguredLLMIsServiceUnavailable(t *testing.T) {
	requireDB(t)

	prev := testHandler.LLM
	testHandler.LLM = nil
	t.Cleanup(func() { testHandler.LLM = prev })

	rec := httptest.NewRecorder()
	testHandler.AskExpert(rec, newRequest(http.MethodPost, "/api/ask", map[string]string{
		"expert":   uuidToString(chatTitleTestAgentID(t)),
		"question": "Is anyone answering?",
	}))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when the LLM layer is unconfigured, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

func TestBuildAskSystemPrompt_CarriesExpertIdentity(t *testing.T) {
	prompt := buildAskSystemPrompt(db.Agent{
		Name:         "Wary Tester",
		Description:  "Guards the review gate.",
		Instructions: "Always check the Makefile targets before trusting a green run.",
	})

	for _, want := range []string{
		"Wary Tester",
		"Guards the review gate.",
		"Always check the Makefile targets before trusting a green run.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("expected system prompt to contain %q, got:\n%s", want, prompt)
		}
	}
	// The bail-out instruction is the product contract: a fast "I don't know"
	// beats a slow guess. Losing it silently turns this into a speculation
	// engine, so pin it.
	if !strings.Contains(prompt, "I don't know") {
		t.Fatalf("expected the prompt to license a fast I-don't-know, got:\n%s", prompt)
	}
	if !strings.Contains(prompt, "no tools") {
		t.Fatalf("expected the prompt to state the expert has no tools, got:\n%s", prompt)
	}
}

func TestBuildAskSystemPrompt_HandlesBareAgent(t *testing.T) {
	prompt := buildAskSystemPrompt(db.Agent{Name: "Bolt Scout"})
	if !strings.Contains(prompt, "Bolt Scout") {
		t.Fatalf("expected the name in the prompt, got:\n%s", prompt)
	}
	if !strings.Contains(prompt, "no recorded specialization") {
		t.Fatalf("expected the no-specialization fallback for an agent with no description or instructions, got:\n%s", prompt)
	}
}

func TestBuildAskUserPrompt_LabelsBackground(t *testing.T) {
	if got := buildAskUserPrompt("Which flag?", ""); got != "Which flag?" {
		t.Fatalf("expected the bare question without context, got %q", got)
	}

	got := buildAskUserPrompt("Which flag?", "Checking out a repo on a task branch.")
	if !strings.Contains(got, "Background") || !strings.Contains(got, "My question:") {
		t.Fatalf("expected background and question to be labelled separately, got:\n%s", got)
	}
	if strings.Index(got, "Checking out a repo") > strings.Index(got, "Which flag?") {
		t.Fatalf("expected background to precede the question, got:\n%s", got)
	}
}

func TestSanitizeAskAnswer(t *testing.T) {
	if got := sanitizeAskAnswer("  answer  "); got != "answer" {
		t.Fatalf("expected surrounding whitespace trimmed, got %q", got)
	}
	// Internal formatting is prose the expert chose; unlike a chat title it
	// must not be collapsed or rewritten.
	multiline := "First line.\n\nSecond line."
	if got := sanitizeAskAnswer(multiline); got != multiline {
		t.Fatalf("expected internal formatting preserved, got %q", got)
	}
	if got := sanitizeAskAnswer("   \n\t "); got != "" {
		t.Fatalf("expected whitespace-only completion to become empty, got %q", got)
	}
	long := strings.Repeat("z", askMaxAnswerLen+50)
	if got := sanitizeAskAnswer(long); len([]rune(got)) != askMaxAnswerLen {
		t.Fatalf("expected answer capped at %d runes, got %d", askMaxAnswerLen, len([]rune(got)))
	}
}

func TestAskModel_PrefersConfiguredAskModel(t *testing.T) {
	requireDB(t)

	prevCfg := testHandler.cfg.LLMAskModel
	t.Cleanup(func() { testHandler.cfg.LLMAskModel = prevCfg })

	testHandler.cfg.LLMAskModel = "  flash-mini  "
	if got := testHandler.askModel(); got != "flash-mini" {
		t.Fatalf("expected the configured ask model to win, got %q", got)
	}

	// Unset falls back to the LLM layer's own default rather than to empty,
	// so the answer can report which model actually spoke.
	testHandler.cfg.LLMAskModel = ""
	if got := testHandler.askModel(); got != testHandler.LLM.DefaultModel() {
		t.Fatalf("expected fallback to the LLM default model %q, got %q", testHandler.LLM.DefaultModel(), got)
	}
}
