// Dictation into a message box: recorded audio uses the configured server transcriber; otherwise the browser's
// Web Speech API supplies live words. Nothing is sent as a message by itself.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, notify } from "./store.js";
import { html, Icon } from "./ui.js";

/** The browser's recognizer, looked up when used (so a page can stand one in), or undefined where there is none. */
const Recognizer = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

/** Whether the mic can work here: a recognizer, and a page browsers give the microphone to (https, or this machine). */
const canRecord = () =>
    globalThis.isSecureContext !== false &&
    typeof globalThis.MediaRecorder === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
let recordedAvailable = false;

export const voiceAvailable = () =>
    globalThis.isSecureContext !== false &&
    (typeof Recognizer() === "function" || (recordedAvailable && canRecord()));

/** What each of the recognizer's errors means for the person; those not here are named as they are. */
const ERRORS = {
    "not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
    "service-not-allowed": "This browser does not allow dictation here.",
    "no-speech": "No speech heard. Tap the mic and try again.",
    "audio-capture": "No microphone found.",
    network: "Dictation needs the network: the browser recognises speech on its own servers.",
    "language-not-supported": "This browser cannot recognise your language.",
};

/** The dictation that listens now: one at a time, in the whole app. */
let current = null;
/**
 * The boxes that can dictate, newest last. The shortcut (Alt+V) dictates into PiP's while it shows (its box is `top`),
 * else into the newest in the page: one gone for now (view only, someone else's turn) is passed over.
 */
const boxes = [];

/** Alt+V: start or stop dictation in PiP's box or the newest; false when no box can. */
export function toggleDictation() {
    const shown = (each) => each.box.current?.isConnected === true;
    const box = boxes.findLast((each) => each.top && shown(each)) ?? boxes.findLast(shown);

    if (!box || !voiceAvailable()) {
        return false;
    }

    box.toggle();

    return true;
}

/**
 * How long the starts of `a` and `b` agree, and their ends, each on its own: an edit that repeats what is beside it
 * ("H" typed before "Hello") fits both ways, and either way it is outside what agrees.
 */
function common(a, b) {
    let head = 0;

    while (head < a.length && head < b.length && a[head] === b[head]) {
        head++;
    }

    let tail = 0;

    while (
        tail < a.length &&
        tail < b.length &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
        tail++;
    }

    return { head, tail };
}

/** Words heard, put between what the box has before and after them, with a space where words would touch. */
function join(before, words, after, capitalize = true) {
    if (words === "") {
        return { value: before + after, at: before.length };
    }

    const start = /\S$/.test(before) ? " " : "";
    const end = /^[^\s.,;:!?)]/.test(after) ? " " : "";
    // A sentence's first word starts with a capital, as the browser leaves some in lower case.
    const capital = capitalize && (before.trim() === "" || /[.!?]\s*$/.test(before));
    const said = capital ? words[0].toUpperCase() + words.slice(1) : words;
    const head = before + start + said;

    return { value: head + end + after, at: head.length };
}

/**
 * Dictation into a textarea (`box`, a ref). `onText(value, caret)` hears each change, as typing does, so the box's own
 * draft saving keeps it. Words go in at the caret while the box has the focus, and after its text when it does not.
 * Returns whether it listens, and `toggle` and `stop` (`stop(true)` drops words not yet settled: for sending, leaving).
 * `top` marks PiP's box, which takes Alt+V while it shows.
 */
export function useDictation(box, onText, { top = false } = {}) {
    const [listening, setListening] = useState(false);
    const [busy, setBusy] = useState(false);
    const [, refresh] = useState(0);
    const hear = useRef(onText);
    const self = useRef(null);

    hear.current = onText;

    if (self.current === null) {
        self.current = {
            box,
            top,
            recognition: null,
            recording: null,
            async record() {
                current?.stop(true);
                current = this;
                const run = {
                    controller: new AbortController(),
                    stream: null,
                    recorder: null,
                    timer: null,
                };

                this.recording = run;
                setBusy(true);
                const valid = () => this.recording === run;

                const release = () => {
                    clearTimeout(run.timer);
                    run.stream?.getTracks().forEach((track) => track.stop());
                };

                try {
                    run.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

                    if (!valid()) {
                        release();

                        return;
                    }

                    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
                        (type) => MediaRecorder.isTypeSupported(type),
                    );

                    if (!mimeType) {
                        throw new Error("This browser cannot record webm or mp4 audio.");
                    }

                    const recorder = new MediaRecorder(run.stream, { mimeType });

                    run.recorder = recorder;
                    const chunks = [];
                    let bytes = 0;

                    recorder.ondataavailable = (event) => {
                        if (!valid()) {
                            return;
                        }

                        bytes += event.data.size;

                        if (bytes > 20 * 1024 * 1024) {
                            this.stop(true);
                            notify("error", "Dictation exceeded 20 MB. Try a shorter recording.");

                            return;
                        }

                        chunks.push(event.data);
                    };

                    recorder.onerror = () => {
                        this.stop(true);
                        notify("error", "Audio recording failed. Try again.");
                    };

                    recorder.onstop = async () => {
                        release();

                        if (!valid()) {
                            return;
                        }

                        setListening(false);
                        setBusy(true);

                        try {
                            const audio = new Blob(chunks, { type: recorder.mimeType || mimeType });

                            if (!audio.size) {
                                notify("info", "No speech heard. Tap the mic and try again.");

                                return;
                            }

                            const result = await api("transcribe", audio, {
                                signal: run.controller.signal,
                            });
                            const element = box.current;

                            if (
                                !valid() ||
                                !element?.isConnected ||
                                typeof result.text !== "string"
                            ) {
                                return;
                            }

                            if (!result.text.trim()) {
                                notify("info", "No speech heard. Tap the mic and try again.");

                                return;
                            }

                            const focused = document.activeElement === element;
                            const start = focused ? element.selectionStart : element.value.length;
                            const end = focused ? element.selectionEnd : start;
                            const { value, at } = join(
                                element.value.slice(0, start),
                                result.text.trim(),
                                element.value.slice(end),
                                false,
                            );

                            element.value = value;

                            if (focused) {
                                element.setSelectionRange(at, at);
                            }

                            hear.current(value, at);
                        } catch (error) {
                            if (valid() && error.name !== "AbortError") {
                                notify("error", `Transcription failed: ${error.message ?? error}`);
                            }
                        } finally {
                            if (valid()) {
                                this.stop(true);
                            }
                        }
                    };

                    recorder.start(1000);
                    setBusy(false);
                    setListening(true);
                    run.timer = setTimeout(() => this.stop(), 5 * 60 * 1000);
                } catch (error) {
                    release();

                    if (valid()) {
                        this.stop(true);
                        notify("error", `Dictation did not start: ${error.message ?? error}`);
                    }
                }
            },
            /** Stop listening: `drop` throws away what is not settled yet, and anything heard after. */
            stop(drop = false) {
                const run = this.recording;

                if (run) {
                    clearTimeout(run.timer);

                    if (drop || !run.recorder) {
                        this.recording = null;
                        run.controller.abort();
                        setBusy(false);
                    } else {
                        setBusy(true);
                    }

                    setListening(false);

                    if (run.recorder?.state !== "inactive") {
                        run.recorder?.stop();
                    }

                    run.stream?.getTracks().forEach((track) => track.stop());

                    if (current === this && !this.recording) {
                        current = null;
                    }

                    return;
                }

                const recognition = this.recognition;

                if (!recognition) {
                    return;
                }

                this.recognition = null;
                setListening(false);

                if (current === this) {
                    current = null;
                }

                if (drop) {
                    recognition.onresult = null;
                    recognition.abort();
                } else {
                    recognition.stop();
                }
            },
            start() {
                if (recordedAvailable && canRecord()) {
                    this.record();

                    return;
                }

                const element = box.current;
                const Recognition = Recognizer();

                if (!element || typeof Recognition !== "function") {
                    return;
                }

                current?.stop();
                current = this;

                const recognition = new Recognition();

                recognition.lang = navigator.language || "en-US";
                recognition.continuous = true;
                recognition.interimResults = true;
                this.recognition = recognition;

                // What the box had around the words, the results already in it, and the box as dictation left it: its
                // text and its selection. `pending` is the first result not settled yet, and `span` where its words are.
                let base = null;
                let from = 0;
                let seen = 0;
                let written = "";
                let selection = [0, 0];
                let pending = 0;
                let span = [0, 0];
                // The person moved on while words were still coming: those finish where they are, then words go where
                // the person is.
                let moving = false;

                const focused = () => document.activeElement === element;
                const selected = () => [element.selectionStart, element.selectionEnd];

                const rebase = () => {
                    const at = focused() ? element.selectionStart : element.value.length;
                    const end = focused() ? element.selectionEnd : at;

                    base = { before: element.value.slice(0, at), after: element.value.slice(end) };
                    from = seen;
                    moving = false;
                };

                rebase();
                written = element.value;
                selection = selected();

                /**
                 * Typed into, or the caret moved, since the words last went in. Outside the words still coming, those
                 * finish where they are, around what the person did; on them, the person's edit wins, and what is heard
                 * next goes where the caret is.
                 */
                const changed = () => {
                    const value = element.value;
                    const [s, e] = span;
                    const { head, tail } = common(written, value);
                    // Where the edit was in what dictation wrote: after the words coming (they are in the start that
                    // agrees), or before them (in the end that agrees).
                    const after = value === written || head >= e;
                    const before = !after && written.length - tail <= s;

                    if (pending >= seen || !(after || before)) {
                        rebase();

                        return;
                    }

                    const shift = before ? value.length - written.length : 0;

                    base = { before: value.slice(0, s + shift), after: value.slice(e + shift) };
                    from = pending;
                    moving = true;
                };

                recognition.onresult = (event) => {
                    const results = event.results;

                    if (
                        element.value !== written ||
                        (focused() && selected().some((at, index) => at !== selection[index]))
                    ) {
                        changed();
                    }

                    // What is settled, then what may still change, from the first result not settled on.
                    let first = from;

                    while (first < results.length && results[first].isFinal) {
                        first++;
                    }

                    const said = (start, end) => {
                        const words = [];

                        for (let index = start; index < end; index++) {
                            words.push(results[index][0].transcript.trim());
                        }

                        return words.filter(Boolean).join(" ");
                    };

                    const settled = said(from, first);
                    const coming = said(first, results.length);
                    const all = [settled, coming].filter(Boolean).join(" ");
                    const { value, at } = join(base.before, all, base.after);
                    // Where the words still coming start: after the settled ones and a space, or where all start.
                    const start =
                        settled === ""
                            ? base.before.length + (all !== "" && /\S$/.test(base.before) ? 1 : 0)
                            : join(base.before, settled, base.after).at + (coming === "" ? 0 : 1);
                    // Where the text after the words ends up: the person's selection there moves with it.
                    const was = element.value.length - base.after.length;
                    const now = value.length - base.after.length;
                    const person = selected();

                    seen = results.length;
                    pending = first;
                    span = [start, at];
                    written = value;
                    element.value = value;

                    if (focused()) {
                        const place = (point) =>
                            point >= was ? point + now - was : Math.min(point, now);

                        if (moving) {
                            element.setSelectionRange(place(person[0]), place(person[1]));
                        } else {
                            element.setSelectionRange(at, at);
                        }
                    }

                    selection = selected();
                    hear.current(value, moving ? selection[1] : at);

                    // The words left behind are all settled: what comes next goes where the person is.
                    if (moving && first === results.length) {
                        rebase();
                    }
                };

                recognition.onerror = (event) => {
                    // Aborted is this app's own doing; no speech for a while ends a quiet dictation, said once.
                    if (event.error !== "aborted") {
                        const level = event.error === "no-speech" ? "info" : "error";

                        notify(level, ERRORS[event.error] ?? `Dictation stopped: ${event.error}.`);
                    }
                };

                recognition.onend = () => {
                    if (this.recognition === recognition) {
                        this.stop();
                    }
                };

                try {
                    recognition.start();
                    setListening(true);
                } catch (error) {
                    this.recognition = null;
                    current = null;
                    notify("error", `Dictation did not start: ${error.message ?? error}`);
                }
            },
            toggle() {
                if (this.recording) {
                    if (this.recording.recorder?.state === "recording") {
                        this.stop();
                    }
                } else if (this.recognition) {
                    this.stop();
                } else {
                    this.start();
                }
            },
        };
    }

    const dictation = self.current;

    // The newest box takes the shortcut while it shows; leaving it ends dictation, as does the tab going out of sight.
    useEffect(() => {
        const hidden = () => document.hidden && dictation.stop(true);
        let mounted = true;

        api("transcribe").then(
            (status) => {
                if (mounted) {
                    recordedAvailable = status.available === true;
                    refresh((value) => value + 1);
                }
            },
            () => {},
        );

        boxes.push(dictation);
        document.addEventListener("visibilitychange", hidden);

        return () => {
            mounted = false;
            boxes.splice(boxes.indexOf(dictation), 1);
            document.removeEventListener("visibilitychange", hidden);
            dictation.stop(true);
        };
    }, []);

    return {
        listening,
        busy,
        toggle: () => dictation.toggle(),
        stop: (drop) => dictation.stop(drop),
    };
}

/** The mic: starts dictation, and while it listens, stops it. None where the browser cannot recognise speech. */
export function MicButton({ dictation, class: className = "", size = 17 }) {
    if (!voiceAvailable()) {
        return null;
    }

    const { listening, busy, toggle } = dictation;

    return html`<button
        type="button"
        class=${`icon-button mic-button ${listening ? "listening" : ""} ${className}`}
        aria-label="Dictate"
        aria-pressed=${listening ? "true" : "false"}
        disabled=${busy}
        title=${busy ? "Preparing microphone or transcribing…" : listening ? "Listening: tap to stop (Alt V)" : "Dictate (Alt V)"}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${toggle}
    >
        <${Icon} name="mic" size=${size} />
    </button>`;
}
