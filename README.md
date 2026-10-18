# Voice speed test

A single web page that times three small text-to-speech voice makers (Pocket TTS, Piper, Kokoro) next to the
system voice, in the browser, on whatever device opens it. It exists to answer one question before anything is
built: can a custom keyboard voice run fast enough on a Surface (Snapdragon X)? It does not touch Benny's Hub.

Test steps for the person running it are in the shared plan ("Custom Keyboard Voice: Test Plan").

## Run it here

    python -m http.server 8795 --bind 127.0.0.1      (from this folder)
    http://127.0.0.1:8795/index.html                 models from models/ (local copy)
    http://127.0.0.1:8795/index.html?remote=1        models from the internet, as when hosted

`models/pocket/english_2026-04/` is a local, git-ignored copy of the Pocket TTS English files (about 200 MB), used
only on localhost. Hosted, the page reads them from Hugging Face the first time and the service worker keeps them.

## How it works

- `sw.js` adds the cross-origin-isolation headers GitHub Pages cannot send (so ONNX Runtime uses every core) and
  keeps every downloaded file so the page works with Wi-Fi off. The page reloads itself once the first time.
- `pocket/` is the Pocket TTS web worker from KevinAHM's Hugging Face web demo, changed only to take the model
  location from the page (`?base=`). Apache 2.0, see `LICENSE-pocket-web-demo-APACHE-2.0`.
- Piper (`@mintplex-labs/piper-tts-web`) and Kokoro (`kokoro-js`) are loaded from jsDelivr.
- All voices are played the same way: playback starts once 0.3 s of speech is ready, like Pocket's own demo.
- Pocket settings: the page's preset picker sets these address settings (the worker reads them at load):
  `ctx=64` starts the attention cache small and grows it (the model file reserves 1000 steps and copies them every frame;
  same audio, about twice as fast), `threads=N`, `prec=main:fp32,...` other precisions (fp32 from KevinAHM/pocket-tts-onnx),
  `ort=` runtime version, `seed=N` repeatable noise, `level=0` turns off per-voice levelling and the limiter, `lsd=`/`temp=`.
- `?loopsec=20` shortens the "Repeat for 10 minutes" run, for checking the page only.

## Voices and consent

Pocket TTS (Kyutai, CC BY 4.0) forbids copying a voice without the speaker's consent. `voices/sample-*.wav`
are four voices invented from a written description in Voice Studio, not a recording of a person.
`voices/candidate-*.pocketvoice.json` are six more, also designed from descriptions: lower, calmer voices that Pocket
copied cleanly in blind listening tests, exported with Voice Studio's "Export for a low-power device" (voice prints, so
the page needs no encoder for them). The custom voice picker takes any such export.
