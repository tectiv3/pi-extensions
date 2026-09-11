declare module '@earendil-works/pi-coding-agent' {
    export const CONFIG_DIR_NAME: string
    export function getAgentDir(): string
    export function parseFrontmatter<T extends Record<string, unknown>>(
        content: string
    ): { frontmatter: T; body: string }
    export function getMarkdownTheme(): unknown
    export function withFileMutationQueue<T>(
        filePath: string,
        fn: () => Promise<T>
    ): Promise<T>

    export interface EventBus {
        emit(channel: string, data: unknown): void
        on(channel: string, handler: (data: unknown) => void): () => void
    }

    export interface ExtensionAPI {
        registerTool(tool: ToolDefinition): void
        registerCommand(
            name: string,
            opts: {
                description: string
                getArgumentCompletions?: (
                    argumentPrefix: string
                ) => Array<{ value: string; label: string; description: string }>
                handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
            }
        ): void
        on(event: string, handler: (event: any, ctx: any) => void): void
        sendUserMessage(text: string, opts?: { deliverAs?: string }): void
        setModel(model: unknown): Promise<boolean>
        setSessionName(name: string): void
        getSessionName(): string | undefined
        events: EventBus
    }

    export interface ExtensionContext {
        cwd: string
        mode: string
        model?: Record<string, unknown>
        thinkingLevel?: string
        hasUI?: boolean
        isIdle(): boolean
        hasPendingMessages(): boolean
        abort(): void
        /** Fire-and-forget manual compaction (pi: CompactOptions). */
        compact(options?: {
            customInstructions?: string
            onComplete?: (result: unknown) => void
            onError?: (error: Error) => void
        }): void
        isProjectTrusted(): boolean
        getContextUsage(): {
            tokens: number | null
            contextWindow: number | null
            percent: number | null
        } | null
        scopedModels?: unknown[]
        modelRegistry?: {
            find?(provider: string, modelId: string): unknown
            getAvailable?(): unknown[]
        }
        sessionManager: {
            getBranch(): unknown[]
            getSessionId?(): string
            getSessionName?(): string
        }
        ui: {
            custom<T>(
                factory: (
                    tui: TuiHandle,
                    theme: Theme,
                    kb: unknown,
                    done: (value: T) => void
                ) => {
                    render: (width: number) => string[]
                    invalidate: () => void
                    handleInput: (data: string) => void
                    dispose?(): void
                }
            ): Promise<T>
            confirm(title: string, message: string): Promise<boolean>
            input(title: string): Promise<string | undefined>
            notify(message: string, severity: string): void
            setStatus?(key: string, text: string | undefined): void
        }
    }

    export interface ExtensionCommandContext extends ExtensionContext {
        newSession(opts: {
            withSession?: (ctx: ExtensionCommandContext) => void
        }): Promise<{ cancelled?: boolean }>
    }

    interface TuiHandle {
        requestRender(): void
        readonly terminal: { readonly rows: number }
    }

    interface Theme {
        fg(color: string, text: string): string
        bg(color: string, text: string): string
        bold(text: string): string
    }

    interface ToolDefinition {
        name: string
        label: string
        description: string
        parameters: unknown
        executionMode?: string
        execute(
            toolCallId: string,
            params: Record<string, any>,
            signal: AbortSignal | undefined,
            onUpdate: ((partial: any) => void) | undefined,
            ctx: ExtensionContext
        ): Promise<{
            content: Array<{ type: string; text: string }>
            details?: unknown
            isError?: boolean
        }>
        renderCall?(args: Record<string, any>, theme: Theme, context: unknown): unknown
        renderResult?(
            result: { content: Array<{ type: string; text?: string }>; details?: unknown },
            options: { expanded?: boolean },
            theme: Theme,
            context: unknown
        ): unknown
    }
}

declare module '@earendil-works/pi-tui' {
    export interface Component {
        render(width: number): string[]
        invalidate?(): void
        handleInput?(data: string): void
    }
    export class Text {
        constructor(text: string, x: number, y: number)
        render(width: number): string[]
    }
    export class Container {
        addChild(child: unknown): void
    }
    export class Markdown {
        constructor(text: string, x: number, y: number, theme: unknown)
        render(width: number): string[]
    }
    export class Spacer {
        constructor(lines: number)
    }
    export class Editor {
        constructor(tui: unknown, theme: EditorTheme)
        onSubmit: ((value: string) => void) | null
        setText(text: string): void
        handleInput(data: string): void
        render(width: number): string[]
    }
    export interface EditorTheme {
        borderColor: (s: string) => string
        selectList: {
            selectedPrefix: (t: string) => string
            selectedText: (t: string) => string
            description: (t: string) => string
            scrollInfo: (t: string) => string
            noMatch: (t: string) => string
        }
    }
    export const Key: {
        escape: string
        enter: string
        backspace: string
        up: string
        down: string
        left: string
        right: string
        tab: string
        home: string
        end: string
        pageUp: string
        pageDown: string
        shift(key: string): string
    }
    export function matchesKey(data: string, key: string): boolean
    export function decodeKittyPrintable(data: string): string | undefined
    export function visibleWidth(text: string): number
    export function wrapTextWithAnsi(text: string, width: number): string[]
}

declare module '@earendil-works/pi-agent-core' {
    export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high'
    export interface AgentToolResult<T = unknown> {
        content: Array<{ type: string; text: string }>
        details?: T
        isError?: boolean
    }
}

declare module '@earendil-works/pi-ai' {
    export function StringEnum<T extends readonly string[]>(
        values: T,
        opts?: Record<string, unknown>
    ): unknown
    export function uuidv7(): string
    export interface Message {
        role: string
        content: Array<{
            type: string
            text?: string
            thinking?: string
            name?: string
            arguments?: Record<string, unknown>
            [key: string]: unknown
        }>
        usage?: {
            input?: number
            output?: number
            cacheRead?: number
            cacheWrite?: number
            cost?: { total?: number }
            totalTokens?: number
        }
        model?: string
        stopReason?: string
        errorMessage?: string
    }
}

declare module 'typebox' {
    interface SchemaOptions {
        description?: string
        default?: unknown
        minimum?: number
        minItems?: number
    }
    interface TSchema {}
    export const Type: {
        Object(properties: Record<string, TSchema>, options?: SchemaOptions): TSchema
        String(options?: SchemaOptions): TSchema
        Number(options?: SchemaOptions): TSchema
        Boolean(options?: SchemaOptions): TSchema
        Array(item: TSchema, options?: SchemaOptions): TSchema
        Optional(schema: TSchema): TSchema
    }
}
