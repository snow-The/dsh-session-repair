export declare const name = "session-repair";
export declare const inject: string[];
type Json = null | boolean | number | string | Json[] | {
    [k: string]: Json | undefined;
};
interface Tool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, Json>;
        required?: string[];
    };
    output: {
        schema: Json;
        render: (args: Json, value: Json) => {
            type: 'text';
            text: string;
        }[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: () => boolean;
    presentCall?: (args: Json) => Json;
    execute: (args: Json, exec: {
        signal?: AbortSignal;
    }) => Promise<Json>;
}
interface Ctx {
    tools: {
        register: (tool: Tool) => void;
    };
}
export type DecodeFailureKind = 'out-of-memory' | 'no-zstd-cli' | 'format' | 'unknown';
/**
 * Why a decode failed — and the distinction matters more than the failure itself.
 *
 * The harness reports EVERY decoder failure as "corrupt Zstandard session log: header
 * frame failed validation" (dsh-session-persistence-jsonl/lib/index.js:3150 simply wraps
 * the decoder error). A transient allocation failure therefore looks exactly like real
 * corruption, and chasing that phantom is how a healthy session gets "repaired" into
 * nothing. Classify first; only 'format' is corruption.
 */
export declare function classifyDecodeFailure(err: unknown): DecodeFailureKind;
export interface DecodeResult {
    text: string | null;
    failure: DecodeFailureKind | null;
    detail: string;
}
export declare function apply(ctx: Ctx): void;
export {};
