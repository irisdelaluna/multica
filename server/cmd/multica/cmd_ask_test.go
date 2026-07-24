package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func newAskTestCmd(t *testing.T, serverURL string) *cobra.Command {
	t.Helper()

	// newAPIClient refuses a non-task token when it detects a daemon task
	// marker anywhere above the working directory. That happens whenever these
	// tests run from inside an agent task workdir, so pin a task-shaped token
	// to keep the check satisfied regardless of where the suite is invoked.
	t.Setenv("MULTICA_TOKEN", "mat_ask_test_token")

	cmd := &cobra.Command{Use: "ask-test"}
	cmd.Flags().String("server-url", "", "")
	cmd.Flags().String("workspace-id", "", "")
	cmd.Flags().String("profile", "", "")
	cmd.Flags().String("output", "text", "")
	_ = cmd.Flags().Set("server-url", serverURL)
	_ = cmd.Flags().Set("workspace-id", "ws-1")

	// Each test drives the package-level flag vars directly, so reset them to
	// their declared defaults rather than inheriting the previous test's edits.
	askContextFlag = ""
	askTimeoutFlag = 30 * time.Second
	return cmd
}

// askStubServer answers agent resolution and the ask itself. It records the
// decoded /api/ask body so tests can assert what was actually sent.
func askStubServer(t *testing.T, answer string, got *map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/agents":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"id": "11111111-1111-1111-1111-111111111111", "name": "Wary Tester"},
				{"id": "22222222-2222-2222-2222-222222222222", "name": "Bolt Scout"},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/ask":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode ask body: %v", err)
			}
			if got != nil {
				*got = body
			}
			_ = json.NewEncoder(w).Encode(askResult{
				ExpertID:   body["expert"],
				ExpertName: "Wary Tester",
				Answer:     answer,
				Model:      "flash-mini",
				ElapsedMs:  412,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The expert is named, not UUID'd, at the call site — resolving the name is
// the CLI's job so the endpoint stays a pure-UUID boundary.
func TestRunAsk_ResolvesExpertNameAndPrintsAnswer(t *testing.T) {
	var sent map[string]string
	srv := askStubServer(t, "Use --ref.", &sent)

	cmd := newAskTestCmd(t, srv.URL)
	var out bytes.Buffer
	cmd.SetOut(&out)

	if err := runAsk(cmd, []string{"Wary Tester", "Which flag pins the branch?"}); err != nil {
		t.Fatalf("runAsk: %v", err)
	}

	if sent["expert"] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("expected the resolved agent UUID to be sent, got %q", sent["expert"])
	}
	if sent["question"] != "Which flag pins the branch?" {
		t.Fatalf("unexpected question sent: %q", sent["question"])
	}
	// Text mode puts the bare answer on stdout so it can be piped without
	// stripping attribution first.
	if strings.TrimSpace(out.String()) != "Use --ref." {
		t.Fatalf("expected the bare answer on stdout, got %q", out.String())
	}
}

func TestRunAsk_ForwardsContextFlag(t *testing.T) {
	var sent map[string]string
	srv := askStubServer(t, "Yes.", &sent)

	cmd := newAskTestCmd(t, srv.URL)
	cmd.SetOut(&bytes.Buffer{})
	askContextFlag = "  Checking out a repo on a task branch.  "

	if err := runAsk(cmd, []string{"Wary Tester", "Does that helper exist?"}); err != nil {
		t.Fatalf("runAsk: %v", err)
	}
	if sent["context"] != "Checking out a repo on a task branch." {
		t.Fatalf("expected trimmed context to be forwarded, got %q", sent["context"])
	}
}

func TestRunAsk_JSONOutputCarriesAttribution(t *testing.T) {
	srv := askStubServer(t, "Use --ref.", nil)

	cmd := newAskTestCmd(t, srv.URL)
	var out bytes.Buffer
	cmd.SetOut(&out)
	_ = cmd.Flags().Set("output", "json")

	if err := runAsk(cmd, []string{"Wary Tester", "Which flag?"}); err != nil {
		t.Fatalf("runAsk: %v", err)
	}

	var decoded askResult
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("decode json output: %v (out=%s)", err, out.String())
	}
	if decoded.Answer != "Use --ref." || decoded.ExpertName != "Wary Tester" || decoded.Model != "flash-mini" {
		t.Fatalf("unexpected json result: %+v", decoded)
	}
}

func TestRunAsk_RejectsEmptyInputs(t *testing.T) {
	srv := askStubServer(t, "never reached", nil)

	cases := []struct {
		name string
		args []string
	}{
		{"blank expert", []string{"   ", "a question"}},
		{"blank question", []string{"Wary Tester", "   "}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd := newAskTestCmd(t, srv.URL)
			cmd.SetOut(&bytes.Buffer{})
			if err := runAsk(cmd, tc.args); err == nil {
				t.Fatal("expected an error, got nil")
			}
		})
	}
}

// A non-positive --timeout would otherwise become an already-expired context
// and surface as a confusing network error instead of a usage error.
func TestRunAsk_RejectsNonPositiveTimeout(t *testing.T) {
	srv := askStubServer(t, "never reached", nil)

	cmd := newAskTestCmd(t, srv.URL)
	cmd.SetOut(&bytes.Buffer{})
	askTimeoutFlag = 0

	if err := runAsk(cmd, []string{"Wary Tester", "Which flag?"}); err == nil {
		t.Fatal("expected an error for --timeout 0, got nil")
	}
}

// An unknown expert must fail at resolution with a name-bearing error rather
// than sending an unresolved string to the server.
func TestRunAsk_UnknownExpertFailsBeforeRequest(t *testing.T) {
	var sent map[string]string
	srv := askStubServer(t, "never reached", &sent)

	cmd := newAskTestCmd(t, srv.URL)
	cmd.SetOut(&bytes.Buffer{})

	err := runAsk(cmd, []string{"Nobody At All", "Which flag?"})
	if err == nil {
		t.Fatal("expected an error for an unknown expert, got nil")
	}
	if sent != nil {
		t.Fatalf("expected no ask request to be sent, got %+v", sent)
	}
}
