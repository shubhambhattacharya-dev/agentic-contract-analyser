import { logger } from "../../lib/logger.js";
import type {
  RegisteredTool,
  ToolRegistry,
} from "./execute-tool.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_TOOL_NAME_LENGTH = 64 as const;

export const MIN_TOOL_DESCRIPTION_LENGTH = 10 as const;

const TOOL_NAME_PATTERN = new RegExp(
  `^[\\w-]{1,${MAX_TOOL_NAME_LENGTH}}$`,
  "u",
);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safe metadata exposed to the agent model.
 *
 * Deliberately excludes:
 * - inputSchema
 * - execute()
 * - backend implementation details
 */
export interface ToolDefinition {
  name: string;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class AgentToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolRegistryError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central registry for agent tools.
 *
 * Security rules:
 *
 * 1. Only explicitly registered tools can execute.
 * 2. Tool names must use a safe identifier format.
 * 3. Tool descriptions must provide useful model guidance.
 * 4. Only name + description are exposed to the model.
 * 5. Tool schemas and execution functions remain backend-only.
 */
export class AgentToolRegistry implements ToolRegistry {
  private readonly tools: ReadonlyMap<
    string,
    RegisteredTool
  >;

  constructor(
    tools: readonly RegisteredTool[],
  ) {
    const registry = new Map<
      string,
      RegisteredTool
    >();

    for (const tool of tools) {
      // ───────────────────────────────────────────────────────────────────
      // 1. Validate tool object
      // ───────────────────────────────────────────────────────────────────

      if (!tool) {
        throw new AgentToolRegistryError(
          "Cannot register an undefined agent tool.",
        );
      }

      if (
        typeof tool.name !== "string" ||
        typeof tool.description !== "string" ||
        typeof tool.execute !== "function"
      ) {
        throw new AgentToolRegistryError(
          "Invalid agent tool registration.",
        );
      }

      // ───────────────────────────────────────────────────────────────────
      // 2. Validate tool name
      // ───────────────────────────────────────────────────────────────────

      const toolName = tool.name.trim();

      if (
        toolName.length === 0 ||
        toolName.length > MAX_TOOL_NAME_LENGTH ||
        !TOOL_NAME_PATTERN.test(toolName)
      ) {
        throw new AgentToolRegistryError(
          `Invalid tool name: "${tool.name}". ` +
            `Tool names must contain only letters, numbers, ` +
            `underscores, or hyphens and be at most ` +
            `${MAX_TOOL_NAME_LENGTH} characters.`,
        );
      }

      // ───────────────────────────────────────────────────────────────────
      // 3. Validate description
      // ───────────────────────────────────────────────────────────────────

      if (
        tool.description.trim().length <
        MIN_TOOL_DESCRIPTION_LENGTH
      ) {
        throw new AgentToolRegistryError(
          `Tool "${toolName}" must have a description of at least ` +
            `${MIN_TOOL_DESCRIPTION_LENGTH} characters.`,
        );
      }

      // ───────────────────────────────────────────────────────────────────
      // 4. Prevent duplicate registration
      // ───────────────────────────────────────────────────────────────────

      if (registry.has(toolName)) {
        logger.error(
          {
            tool: toolName,
          },
          "Duplicate agent tool registration detected.",
        );

        throw new AgentToolRegistryError(
          `Duplicate agent tool registered: "${toolName}".`,
        );
      }

      // ───────────────────────────────────────────────────────────────────
      // 5. Store validated tool
      // ───────────────────────────────────────────────────────────────────

      registry.set(toolName, tool);
    }

    this.tools = registry;

    logger.debug(
      {
        toolCount: registry.size,
        tools: [...registry.keys()],
      },
      "Agent tool registry initialized.",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Resolve
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns a registered tool by name.
   *
   * Used by ToolExecutor to gate model-requested tool calls.
   */
  get(
    name: string,
  ): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Definitions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns only safe metadata for the model.
   *
   * The model receives:
   * - name
   * - description
   *
   * The model never receives:
   * - inputSchema
   * - execute()
   * - backend implementation details
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(
      this.tools.values(),
    ).map(
      ({
        name,
        description,
      }) => ({
        name,
        description,
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Existence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true when the requested tool is registered.
   *
   * Kept as a dedicated method for explicit intent at call sites.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }
}