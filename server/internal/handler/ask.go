package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/llm"
)

// Ask (IRI-76) is the "consult an expert" path: an agent mid-task needs one
// fact — which flag, where something lives, whether X already exists — and must
// keep working within seconds. Enqueueing a task for the agent that knows would
// cost a worktree, a CLI spawn, a full context load, and a whole comment
// thread; the asker would guess instead, which is the behavior this replaces.
//
// So this is deliberately NOT the agent runtime. It is one server-side
// inference call wearing the expert's identity, answering from context it
// already has. Nothing is persisted: no task, no comment, no message row. The
// request blocks and the answer comes back on the same HTTP response.
//
// The latency budget is the whole design. Everything below exists to keep the
// round trip in seconds: a small fixed model, a hard timeout well under the
// llm package's own 60s default, a bounded prompt, and a system prompt that
// tells the expert to bail out loudly rather than think slowly.
const (
	// askTimeout bounds the upstream call. Chosen so a caller that gets no
	// answer still loses only a few seconds and can fall back to asking in a
	// comment thread. A slow expert is a failed expert here.
	askTimeout = 15 * time.Second

	// askMaxQuestionLen and askMaxContextLen bound the prompt in runes. These
	// are latency guards as much as abuse guards: a large prompt is a slow
	// prompt, and a question that does not fit belongs in an issue comment.
	askMaxQuestionLen = 2000
	askMaxContextLen  = 6000

	// askMaxAnswerLen caps the returned answer. The prompt asks for a few
	// sentences; this is the defensive ceiling for a model that ignores it.
	askMaxAnswerLen = 4000
)

// askRequest is the POST /api/ask body.
type askRequest struct {
	// Expert is the agent UUID to consult. Name resolution happens client-side
	// (the CLI resolves a name to an ID) so this stays a pure UUID input.
	Expert string `json:"expert"`
	// Question is what the caller needs to know.
	Question string `json:"question"`
	// Context is optional caller-supplied background — what they are doing,
	// what they already tried. Kept separate from the question so the prompt
	// can frame it as background rather than as part of the ask.
	Context string `json:"context,omitempty"`
}

// askResponse is the POST /api/ask response. It is a reply, not a record:
// there is no id, because nothing was stored.
type askResponse struct {
	ExpertID   string `json:"expert_id"`
	ExpertName string `json:"expert_name"`
	Answer     string `json:"answer"`
	Model      string `json:"model"`
	ElapsedMs  int64  `json:"elapsed_ms"`
}

// askSystemPromptTemplate frames the responder as the expert being consulted,
// not as an agent being assigned work. The rules are the product contract from
// IRI-76: terse, from existing knowledge only, and an explicit fast "I don't
// know" instead of slow speculation. The expert's own description and
// instructions are injected as its role so the answer carries its perspective.
const askSystemPromptTemplate = `You are %s. A colleague has interrupted you with one quick question and is waiting on the answer to continue their own work.

%s

How to answer:
- Be brief. One or two sentences is the target; a single line is ideal.
- Answer only from what you already know. You have no tools and cannot look anything up, run anything, or read any file.
- If you do not know, or the question needs real investigation to answer properly, say exactly that in one line and name who or where would know. A fast "I don't know, ask X" is a useful answer; a slow guess is not.
- Do not speculate, do not hedge at length, and do not reason out loud.
- No preamble, no sign-off, no restating the question. Just the answer.`

// AskExpert handles POST /api/ask.
//
// Authorization piggybacks on loadAgentForUser: the caller must be a member of
// the workspace the expert belongs to. Consulting an expert is a read of its
// identity plus an inference call — it starts no run — so the agent invocation
// permission gate that guards task enqueue deliberately does not apply here.
func (h *Handler) AskExpert(w http.ResponseWriter, r *http.Request) {
	// Fail fast and explicitly when no LLM layer is configured. Unlike chat
	// title generation, which degrades silently, an unanswered question must
	// tell the caller so it can fall back to asking a human.
	if h.LLM == nil || !h.LLM.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "the ask endpoint requires a configured LLM layer (MULTICA_LLM_API_KEY / MULTICA_LLM_BASE_URL)")
		return
	}

	var req askRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	question := strings.TrimSpace(req.Question)
	if question == "" {
		writeError(w, http.StatusBadRequest, "question is required")
		return
	}
	if len([]rune(question)) > askMaxQuestionLen {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("question is too long (max %d characters); ask this in an issue comment instead", askMaxQuestionLen))
		return
	}
	askContext := strings.TrimSpace(req.Context)
	if len([]rune(askContext)) > askMaxContextLen {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("context is too long (max %d characters)", askMaxContextLen))
		return
	}

	if strings.TrimSpace(req.Expert) == "" {
		writeError(w, http.StatusBadRequest, "expert is required")
		return
	}
	// loadAgentForUser resolves the UUID, enforces workspace membership, and
	// writes the 400/404 itself.
	expert, ok := h.loadAgentForUser(w, r, strings.TrimSpace(req.Expert))
	if !ok {
		return
	}

	// Bound the call independently of the request context so a client that
	// waits longer than we do still gets our timeout, not a hung connection.
	ctx, cancel := context.WithTimeout(r.Context(), askTimeout)
	defer cancel()

	model := h.askModel()
	started := time.Now()
	raw, err := h.LLM.GenerateText(ctx, model, buildAskSystemPrompt(expert), buildAskUserPrompt(question, askContext))
	elapsed := time.Since(started)
	if err != nil {
		if errors.Is(err, llm.ErrNotConfigured) {
			writeError(w, http.StatusServiceUnavailable, "the ask endpoint requires a configured LLM layer")
			return
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			// Report the timeout as a gateway timeout rather than a 500: the
			// caller should treat it as "the expert was too slow, move on".
			writeError(w, http.StatusGatewayTimeout, fmt.Sprintf("%s did not answer within %s", expert.Name, askTimeout))
			return
		}
		writeError(w, http.StatusBadGateway, "the expert could not be reached")
		return
	}

	answer := sanitizeAskAnswer(raw)
	if answer == "" {
		writeError(w, http.StatusBadGateway, "the expert returned an empty answer")
		return
	}

	writeJSON(w, http.StatusOK, askResponse{
		ExpertID:   uuidToString(expert.ID),
		ExpertName: expert.Name,
		Answer:     answer,
		Model:      model,
		ElapsedMs:  elapsed.Milliseconds(),
	})
}

// askModel returns the model the responder runs on. A deployment points
// MULTICA_LLM_ASK_MODEL at something flash-class (or a genuinely local model);
// when unset we fall through to the LLM layer's own default by returning "".
// The quality tradeoff is intended: these are lookup-shaped questions, and a
// small model that answers now beats a large one that answers late.
func (h *Handler) askModel() string {
	if model := strings.TrimSpace(h.cfg.LLMAskModel); model != "" {
		return model
	}
	if h.LLM != nil {
		return h.LLM.DefaultModel()
	}
	return ""
}

// buildAskSystemPrompt dresses the responder in the expert's identity. The
// agent's description (what it is) and instructions (how it works) are the
// "relevant knowledge it already has" — the whole reason asking a named expert
// beats asking a generic model.
func buildAskSystemPrompt(expert db.Agent) string {
	name := strings.TrimSpace(expert.Name)
	if name == "" {
		name = "an expert on this workspace"
	}

	var role strings.Builder
	if desc := strings.TrimSpace(expert.Description); desc != "" {
		role.WriteString("Who you are:\n")
		role.WriteString(desc)
	}
	if instructions := strings.TrimSpace(expert.Instructions); instructions != "" {
		if role.Len() > 0 {
			role.WriteString("\n\n")
		}
		role.WriteString("What you know and how you work:\n")
		role.WriteString(instructions)
	}
	if role.Len() == 0 {
		role.WriteString("You have no recorded specialization beyond your name, so answer only what you can genuinely stand behind.")
	}

	return fmt.Sprintf(askSystemPromptTemplate, name, role.String())
}

// buildAskUserPrompt renders the caller's side. Background is labelled so the
// model does not mistake it for part of the question.
func buildAskUserPrompt(question, askContext string) string {
	if askContext == "" {
		return question
	}
	return "Background (what I am doing):\n" + askContext + "\n\nMy question:\n" + question
}

// sanitizeAskAnswer trims the answer and enforces the length ceiling. It
// deliberately does not reformat or strip prefixes the way chat titles do: an
// answer is prose meant to be read as-is, and rewriting it risks changing what
// the expert said.
func sanitizeAskAnswer(raw string) string {
	answer := strings.TrimSpace(raw)
	if answer == "" {
		return ""
	}
	if runes := []rune(answer); len(runes) > askMaxAnswerLen {
		answer = strings.TrimSpace(string(runes[:askMaxAnswerLen]))
	}
	return answer
}
