import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

function stubFetchJson(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skill API schemas", () => {
  it("defaults source markers from older servers", async () => {
    stubFetchJson([{
      id: "skill-1",
      workspace_id: "workspace-1",
      name: "review",
      description: "",
      config: {},
      created_by: null,
      created_at: "",
      updated_at: "",
    }]);

    const skills = await new ApiClient("https://api.example.test").listSkills();
    expect(skills[0]).toMatchObject({
      source: "workspace",
      read_only: false,
    });
  });

  it("preserves built-in markers and content", async () => {
    stubFetchJson({
      id: "builtin:multica-working-on-issues",
      workspace_id: "workspace-1",
      name: "multica-working-on-issues",
      description: "Issue workflow",
      content: "# Working on issues",
      config: {},
      source: "builtin",
      read_only: true,
      created_by: null,
      created_at: "",
      updated_at: "",
      files: [],
    });

    const skill = await new ApiClient("https://api.example.test").getSkill(
      "builtin:multica-working-on-issues",
    );
    expect(skill).toMatchObject({
      source: "builtin",
      read_only: true,
      content: "# Working on issues",
    });
  });
});
