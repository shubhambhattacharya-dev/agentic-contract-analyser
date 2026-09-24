import { z } from "zod";

import { logger } from "../../lib/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_ID_PATTERN = /^[\w-]{1,128}$/u;

const MAX_TOOL_NAME_LENGTH = 64 as const;
const MAX_DOCUMENT_IDS = 5 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trusted context supplied by the backend.
 *
 * The model NEVER controls this object.
 */
export const ExecutionContextSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .regex(
      SAFE_ID_PATTERN,
      "Invalid session ID format.",
    ),

  documentIds: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(
          SAFE_ID_PATTERN,
          "Invalid document ID format.",
        ),
    )
    .min(1)
    .max(MAX_DOCUMENT_IDS),
});

export type ToolExecutionContext =
  z.infer<typeof ExecutionContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_ARGUMENTS"
  | "INVALID_CONTEXT"
  | "TOOL_EXECUTION_ERROR";

export type ExecuteToolResult =
  | {
      ok: true;
      tool: string;
      data: unknown;
    }
  | {
      ok: false;
      tool: string;
      error: string;
      code: ToolErrorCode;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Registered tool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every tool must have an object-shaped Zod schema.
 *
 * The schema validates ONLY model-controlled arguments.
 *
 * sessionId and documentIds are intentionally excluded because
 * they are injected by ToolExecutor from the trusted request context.
 */
export interface RegisteredTool<
  TArgs extends z.ZodRawShape = z.ZodRawShape,
> {
  name: string;

  description: string;

  inputSchema: z.ZodObject<TArgs>;

  execute(
    args: z.output<z.ZodObject<TArgs>>,
  ): Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolRegistry {
  get(
    name: string,
  ):
    | RegisteredTool
    | undefined;

  getDefinitions(): unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Error helper
// ─────────────────────────────────────────────────────────────────────────────

function makeError(
  tool: string,
  code: ToolErrorCode,
  error: string,
): ExecuteToolResult {
  return {
    ok: false,
    tool,
    code,
    error,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool executor
// ─────────────────────────────────────────────────────────────────────────────

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
  ) {}

  /**
   * Executes exactly ONE model-requested tool call.
   *
   * Security boundary:
   *
   * LLM
   *   ↓
   * tool-name validation
   *   ↓
   * registry lookup
   *   ↓
   * trusted context validation
   *   ↓
   * tool-specific Zod validation
   *   ↓
   * trusted argument assembly
   *   ↓
   * backend tool execution
   */
  async execute(options: {
    toolName: string;
    args: unknown;
    sessionId: string;
    documentIds: string[];
  }): Promise<ExecuteToolResult> {
    const {
      toolName,
      args,
      sessionId,
      documentIds,
    } = options;

    // ───────────────────────────────────────────────────────────────────────
    // 1. Validate tool name before registry lookup
    // ───────────────────────────────────────────────────────────────────────

    if (
      typeof toolName !== "string" ||
      toolName.length === 0 ||
      toolName.length > MAX_TOOL_NAME_LENGTH
    ) {
      logger.warn(
        {
          toolNameLength:
            typeof toolName === "string"
              ? toolName.length
              : undefined,
        },
        "Agent supplied an invalid tool name.",
      );

      return makeError(
        typeof toolName === "string"
          ? toolName
          : "",
        "UNKNOWN_TOOL",
        "Tool name is missing or too long.",
      );
    }

    // ───────────────────────────────────────────────────────────────────────
    // 2. Registry lookup
    // ───────────────────────────────────────────────────────────────────────

    const tool = this.registry.get(toolName);

    if (!tool) {
      logger.warn(
        {
          tool: toolName,
        },
        "Agent requested an unknown tool.",
      );

      return makeError(
        toolName,
        "UNKNOWN_TOOL",
        "The requested tool does not exist.",
      );
    }

    // ───────────────────────────────────────────────────────────────────────
    // 3. Validate trusted execution context
    // ───────────────────────────────────────────────────────────────────────

    const contextResult =
      ExecutionContextSchema.safeParse({
        sessionId,
        documentIds,
      });

    if (!contextResult.success) {
      logger.warn(
        {
          tool: toolName,
          issues: contextResult.error.issues,
        },
        "Agent tool execution context failed validation.",
      );

      return makeError(
        toolName,
        "INVALID_CONTEXT",
        "The session or document scope is invalid.",
      );
    }

    const context =
      contextResult.data;

    // ───────────────────────────────────────────────────────────────────────
    // 4. Validate model-controlled arguments
    // ───────────────────────────────────────────────────────────────────────

    const argumentResult =
      tool.inputSchema.safeParse(args);

    if (!argumentResult.success) {
      logger.warn(
        {
          tool: toolName,
          issues: argumentResult.error.issues,
        },
        "Agent tool arguments failed Zod validation.",
      );

      return makeError(
        toolName,
        "INVALID_ARGUMENTS",
        "The tool arguments are invalid.",
      );
    }

    /*
     * IMPORTANT:
     *
     * argumentResult.data is already the output of the tool's
     * ZodObject schema.
     *
     * No `as Record<string, unknown>` cast is required here.
     */
    const validatedArgs =
      argumentResult.data;

    // ───────────────────────────────────────────────────────────────────────
    // 5. Assemble trusted arguments
    // ───────────────────────────────────────────────────────────────────────

    /*
     * sessionId and documentIds are ALWAYS server-controlled.
     *
     * Even if the model attempts:
     *
     * {
     *   "sessionId": "another-session",
     *   "documentIds": ["another-document"]
     * }
     *
     * those values are NOT trusted.
     *
     * The authenticated request context wins.
     */
    const trustedArgs = {
      ...validatedArgs,
      sessionId: context.sessionId,
      documentIds: context.documentIds,
    };

    // ───────────────────────────────────────────────────────────────────────
    // 6. Execute backend tool
    // ───────────────────────────────────────────────────────────────────────

    try {
      const data =
        await tool.execute(trustedArgs);

      logger.debug(
        {
          tool: toolName,
        },
        "Agent tool executed successfully.",
      );

      return {
        ok: true,
        tool: toolName,
        data,
      };
    } catch (error) {
      logger.error(
        {
          tool: toolName,
          error,
        },
        "Agent tool execution threw unexpectedly.",
      );

      return makeError(
        toolName,
        "TOOL_EXECUTION_ERROR",
        "The tool failed while processing the request.",
      );
    }
  }
}