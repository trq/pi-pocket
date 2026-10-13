/** Transient tap-record audio transcription through the owner's OpenAI key; audio is never saved. */
import type { IncomingMessage } from "node:http";
import { HttpError } from "../errors.ts";
import { readBody } from "./io.ts";

const MAX_AUDIO = 20 * 1024 * 1024;
const TYPES: Record<string, string> = {
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
};

export function transcriptionAvailable(): boolean {
    return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/** Each handler caps uploads and paid calls together, including time spent reading the body. */
export function createTranscriber() {
    let active = 0;

    return async (request: IncomingMessage): Promise<{ text: string }> => {
        const key = process.env.OPENAI_API_KEY?.trim();

        if (!key) {
            throw new HttpError(503, "Transcription is not configured");
        }

        const type = (request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
        const extension = TYPES[type];

        if (!extension) {
            throw new HttpError(415, "Send WebM, MP4, or WAV audio");
        }

        if (active >= 2) {
            throw new HttpError(429, "Transcription is busy; try again shortly");
        }

        active++;

        try {
            const audio = await readBody(request, MAX_AUDIO);

            if (audio.length === 0) {
                throw new HttpError(400, "Audio is empty");
            }

            const form = new FormData();

            form.set("file", new Blob([new Uint8Array(audio)], { type }), `recording.${extension}`);
            form.set("model", "gpt-transcribe");

            const signal = AbortSignal.timeout(60_000);

            try {
                const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
                    method: "POST",
                    headers: { authorization: `Bearer ${key}` },
                    body: form,
                    signal,
                    redirect: "error",
                });

                if (!response.ok) {
                    await response.body?.cancel();

                    throw new HttpError(
                        response.status === 429 ? 429 : 502,
                        response.status === 429
                            ? "Transcription provider is busy; try again shortly"
                            : "Transcription provider could not process the audio",
                    );
                }

                const result: unknown = await response.json();

                if (
                    typeof result !== "object" ||
                    result === null ||
                    !("text" in result) ||
                    typeof result.text !== "string"
                ) {
                    throw new HttpError(502, "Transcription provider returned an invalid response");
                }

                return { text: result.text };
            } catch (error) {
                if (error instanceof HttpError) {
                    throw error;
                }

                throw new HttpError(
                    signal.aborted ? 504 : 502,
                    signal.aborted
                        ? "Transcription timed out"
                        : "Transcription provider is unavailable",
                );
            }
        } finally {
            active--;
        }
    };
}
