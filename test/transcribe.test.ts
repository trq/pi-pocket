import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";

test("transcription authenticates, validates, and forwards audio without exposing provider errors", async () => {
    const app = await openApp(scriptedModel(), join(root, "transcribe-data"));
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart() {} }),
    );
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    let calls = 0;
    let fail = false;
    let wait: Promise<void> | undefined;

    globalThis.fetch = (async (input, init) => {
        if (String(input) !== "https://api.openai.com/v1/audio/transcriptions") {
            return originalFetch(input, init);
        }

        calls++;
        await wait;
        assert.equal(
            init?.headers && (init.headers as Record<string, string>).authorization,
            "Bearer test-secret",
        );
        const form = init?.body as FormData;

        assert.equal(form.get("model"), "gpt-transcribe");
        assert.equal(form.get("response_format"), null);
        assert.equal((form.get("file") as File).name, "recording.webm");
        assert.equal(await (form.get("file") as File).text(), "audio");
        assert.ok(init?.signal);

        return fail
            ? new Response("test-secret private provider detail", { status: 401 })
            : Response.json({ text: "Hello" });
    }) as typeof fetch;

    try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/transcribe`;
        const owner = { authorization: `Bearer ${app.config.ownerToken}` };
        const guest = { authorization: `Bearer ${app.config.addUser("Guest", "guest").token}` };
        const post = (headers: Record<string, string>, body = "audio") =>
            originalFetch(url, { method: "POST", headers, body });

        delete process.env.OPENAI_API_KEY;
        assert.equal((await originalFetch(url)).status, 401);
        assert.deepEqual(await (await originalFetch(url, { headers: owner })).json(), {
            available: false,
        });
        process.env.OPENAI_API_KEY = "test-secret";
        assert.deepEqual(await (await originalFetch(url, { headers: owner })).json(), {
            available: true,
        });
        assert.deepEqual(await (await originalFetch(url, { headers: guest })).json(), {
            available: false,
        });
        assert.equal((await post(owner)).status, 403);
        assert.equal((await post({ ...guest, "x-pocket": "1" })).status, 403);
        assert.equal(
            (await post({ ...owner, "x-pocket": "1", "content-type": "audio/ogg" })).status,
            415,
        );
        const headers = { ...owner, "x-pocket": "1", "content-type": "audio/webm;codecs=opus" };

        assert.equal((await post(headers, "")).status, 400);
        assert.equal((await post(headers, "x".repeat(20 * 1024 * 1024 + 1))).status, 413);
        assert.equal(calls, 0);
        assert.deepEqual(await (await post(headers)).json(), { text: "Hello" });
        fail = true;
        const failed = await post(headers);

        assert.equal(failed.status, 502);
        assert.doesNotMatch(await failed.text(), /test-secret|private/);
        fail = false;
        assert.equal((await post(headers)).status, 200);
        let release!: () => void;

        wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        const before = calls;
        const first = post(headers);
        const second = post(headers);

        while (calls < before + 2) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        assert.equal((await post(headers)).status, 429);
        release();
        assert.equal((await first).status, 200);
        assert.equal((await second).status, 200);
    } finally {
        globalThis.fetch = originalFetch;

        if (originalKey === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = originalKey;
        }

        await new Promise<void>((resolve) => server.close(() => resolve()));
        await app.close();
        cleanUp();
    }
});
