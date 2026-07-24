package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// `multica ask` is the fast lane for a question an agent hits mid-task
// (IRI-76). It is a request and a reply, not a conversation: the call blocks,
// the answer prints, and nothing is created on the board. Use an issue comment
// thread when the question deserves a durable answer or needs a human.
//
// The whole value is latency, so this command does exactly two round trips:
// resolve the expert name to an agent, then POST the question. No daemon, no
// task, no worktree.
var askCmd = &cobra.Command{
	Use:   "ask <expert> <question>",
	Short: "Ask an expert a question and get an answer back immediately",
	Long: "Consults a workspace agent as an expert and prints its answer. The call blocks until the answer arrives.\n\n" +
		"Nothing is persisted: no issue, no comment, no task run. The expert answers from what it already knows and " +
		"has no tools, so keep questions lookup-shaped (which flag, where something lives, does X already exist). " +
		"An expert that cannot answer quickly says so — take that as a signal to ask in an issue comment thread instead.",
	Args: exactArgs(2),
	RunE: runAsk,
}

var (
	askContextFlag string
	askTimeoutFlag time.Duration
)

// askMaxTimeout ceilings --timeout. The server enforces its own, shorter
// deadline; this only keeps a caller from blocking far past the point where
// asking a human would have been faster.
const askMaxTimeout = 60 * time.Second

func init() {
	askCmd.Flags().StringVar(&askContextFlag, "context", "", "Optional background for the expert: what you are doing, what you already tried")
	askCmd.Flags().DurationVar(&askTimeoutFlag, "timeout", 30*time.Second, "How long to wait for the answer before giving up")
	askCmd.Flags().String("output", "text", "Output format: text or json")
}

// askExpertKinds restricts expert resolution to agents. Members and squads are
// people and routing targets — reaching them is what an issue comment mention
// is for, and neither can answer synchronously.
var askExpertKinds = assigneeKinds{agent: true}

type askResult struct {
	ExpertID   string `json:"expert_id"`
	ExpertName string `json:"expert_name"`
	Answer     string `json:"answer"`
	Model      string `json:"model"`
	ElapsedMs  int64  `json:"elapsed_ms"`
}

func runAsk(cmd *cobra.Command, args []string) error {
	expertRef := strings.TrimSpace(args[0])
	question := strings.TrimSpace(args[1])
	if expertRef == "" {
		return fmt.Errorf("expert is required")
	}
	if question == "" {
		return fmt.Errorf("question is required")
	}

	timeout := askTimeoutFlag
	if timeout <= 0 {
		return fmt.Errorf("--timeout must be positive")
	}
	if timeout > askMaxTimeout {
		timeout = askMaxTimeout
	}

	if _, err := requireWorkspaceID(cmd); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	// --timeout bounds both round trips together: what the caller cares about
	// is how long they block, not which leg was slow.
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	_, expertID, err := resolveAssignee(ctx, client, expertRef, askExpertKinds)
	if err != nil {
		return err
	}

	var result askResult
	if err := client.PostJSON(ctx, "/api/ask", map[string]string{
		"expert":   expertID,
		"question": question,
		"context":  strings.TrimSpace(askContextFlag),
	}, &result); err != nil {
		return fmt.Errorf("ask %s: %w", expertRef, err)
	}

	format, _ := cmd.Flags().GetString("output")
	if strings.EqualFold(format, "json") {
		encoded, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return fmt.Errorf("encode response: %w", err)
		}
		fmt.Fprintln(cmd.OutOrStdout(), string(encoded))
		return nil
	}

	// Text mode puts the answer alone on stdout so it can be piped or read
	// without parsing, and the attribution on stderr so it stays visible
	// without polluting the answer.
	fmt.Fprintln(cmd.OutOrStdout(), result.Answer)
	fmt.Fprintf(os.Stderr, "— %s (%s, %dms)\n", result.ExpertName, result.Model, result.ElapsedMs)
	return nil
}
