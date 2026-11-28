"""
Image worker for the Auto Video tab: FLUX.2-klein-4B (Apache-2.0) through
mflux (MIT) on Apple Silicon, loaded once and kept in memory.

Protocol: one JSON object per line on stdin
    {"id": 1, "prompt": "...", "width": 1280, "height": 720, "seed": 7, "steps": 4, "refs": ["a.png"], "out": "x.png"}
and one per line on stdout
    {"ready": true}                      once, after the model has loaded
    {"id": 1, "ok": true} | {"id": 1, "ok": false, "error": "..."}
Everything else (mflux progress, warnings) goes to stderr.

Run with the Python of the mflux tool environment (`uv tool install mflux`).
The edit variant needs at least one reference image, so a plain text-to-image
variant is built on the same loaded weights: one copy in memory serves both.
"""
import json
import os
import sys
import traceback

out = sys.stdout
sys.stdout = sys.stderr  # keep library prints off the protocol channel


def send(obj):
    out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    out.flush()


def main():
    import mlx.nn as nn
    from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit

    quantize = int(os.environ.get("MFLUX_QUANTIZE", "8")) or None
    edit = Flux2KleinEdit(quantize=quantize)
    # Same modules and settings, different generate_image: no second load, no second 8 GB.
    plain = Flux2Klein.__new__(Flux2Klein)
    nn.Module.__init__(plain)
    for k, v in edit.items():
        dict.__setitem__(plain, k, v)
    for k, v in vars(edit).items():
        object.__setattr__(plain, k, v)
    send({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            common = dict(
                seed=int(req.get("seed", 0)),
                prompt=req["prompt"],
                num_inference_steps=int(req.get("steps", 4)),
                width=int(req["width"]),
                height=int(req["height"]),
            )
            refs = req.get("refs") or []
            image = edit.generate_image(**common, image_paths=refs) if refs else plain.generate_image(**common)
            image.save(path=req["out"], overwrite=True)
            send({"id": req.get("id"), "ok": True})
        except Exception as e:  # noqa: BLE001 — report and keep serving
            traceback.print_exc()
            send({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"[:500]})


if __name__ == "__main__":
    main()
