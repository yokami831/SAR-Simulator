"""Generate icon.ico from icon.svg for Electron app."""
import io
from pathlib import Path

try:
    import cairosvg
except ImportError:
    print("Installing cairosvg...")
    import subprocess
    subprocess.check_call(["pip", "install", "cairosvg"])
    import cairosvg

from PIL import Image

SCRIPT_DIR = Path(__file__).parent
SVG_PATH = SCRIPT_DIR / "icon.svg"
ICO_PATH = SCRIPT_DIR / "icon.ico"
PNG_PATH = SCRIPT_DIR / "icon.png"  # 256px for Electron fallback

SIZES = [16, 32, 48, 64, 128, 256]


def svg_to_png(svg_path: Path, size: int) -> Image.Image:
    """Render SVG to a PIL Image at the given size."""
    png_data = cairosvg.svg2png(
        url=str(svg_path),
        output_width=size,
        output_height=size,
    )
    return Image.open(io.BytesIO(png_data)).convert("RGBA")


def main():
    images = []
    for size in SIZES:
        img = svg_to_png(SVG_PATH, size)
        images.append(img)
        print(f"  Generated {size}x{size}")

    # Save 256px PNG (used by Electron on some platforms)
    images[-1].save(PNG_PATH)
    print(f"Saved {PNG_PATH}")

    # Save ICO with all sizes
    images[0].save(
        ICO_PATH,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=images[1:],
    )
    print(f"Saved {ICO_PATH}")


if __name__ == "__main__":
    main()
