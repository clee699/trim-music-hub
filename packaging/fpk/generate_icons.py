#!/usr/bin/env python3
"""
Generate anti-aliased RGBA PNG icons (64x64 and 256x256) for TRIM Music Hub (.fpk).
Pure Python 3 standard library implementation (struct + zlib + math) with 4x4 supersampling.
"""
import math
import os
import struct
import zlib


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if v < lo else (hi if v > hi else v)


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 1.0 if x >= edge1 else 0.0
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def sd_rounded_box(px: float, py: float, cx: float, cy: float, hx: float, hy: float, r: float) -> float:
    dx = abs(px - cx) - (hx - r)
    dy = abs(py - cy) - (hy - r)
    ox = max(dx, 0.0)
    oy = max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r


def sd_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    pax, pay = px - ax, py - ay
    bax, bay = bx - ax, by - ay
    denom = bax * bax + bay * bay
    h = 0.0 if denom == 0.0 else clamp((pax * bax + pay * bay) / denom)
    return math.hypot(pax - bax * h, pay - bay * h)


def sd_music_note(u: float, v: float) -> float:
    """Signed distance in normalized [0, 1] icon coordinates to a double-eighth-note."""
    # Left & right note heads (tilted ellipses approximated nicely)
    def sd_tilted_head(px: float, py: float, cx: float, cy: float) -> float:
        ang = -0.35
        ca, sa = math.cos(ang), math.sin(ang)
        dx, dy = px - cx, py - cy
        rx = dx * ca - dy * sa
        ry = dx * sa + dy * ca
        # Radii: a=0.092, b=0.070
        return (math.hypot(rx / 0.092, ry / 0.070) - 1.0) * 0.078

    d_head_l = sd_tilted_head(u, v, 0.34, 0.69)
    d_head_r = sd_tilted_head(u, v, 0.64, 0.63)

    # Vertical stems
    stem_half_w = 0.030
    d_stem_l = sd_segment(u, v, 0.408, 0.675, 0.408, 0.305) - stem_half_w
    d_stem_r = sd_segment(u, v, 0.708, 0.615, 0.708, 0.245) - stem_half_w

    # Slanted top double beam
    d_beam_top = sd_segment(u, v, 0.408, 0.305, 0.708, 0.245) - 0.038
    d_beam_sub = sd_segment(u, v, 0.408, 0.405, 0.708, 0.345) - 0.024

    return min(d_head_l, d_head_r, d_stem_l, d_stem_r, d_beam_top, d_beam_sub)


def sample_color(u: float, v: float):
    """Return premultiplied (r, g, b, a) in [0, 1] at normalized coordinate (u, v)."""
    d_bg = sd_rounded_box(u, v, 0.5, 0.5, 0.46, 0.46, 0.215)
    if d_bg > 0.006:
        return (0.0, 0.0, 0.0, 0.0)

    alpha_bg = 1.0 - smoothstep(-0.004, 0.004, d_bg)

    # Rich dark-slate -> emerald/teal diagonal gradient
    t_diag = clamp(0.55 * u + 0.45 * (1.0 - v))
    # Base gradient from deep emerald (#064e3b) to vibrant emerald (#10b981) & cyan-teal (#14b8a6)
    r = 0.04 + 0.05 * t_diag + 0.04 * (1.0 - v)
    g = 0.36 + 0.38 * t_diag + 0.06 * (1.0 - v)
    b = 0.28 + 0.35 * t_diag + 0.08 * u

    # Subtle radial glow near top-left
    glow_d = math.hypot(u - 0.28, v - 0.22)
    glow = math.exp(-glow_d * glow_d * 4.2) * 0.22
    r = clamp(r + glow * 0.55)
    g = clamp(g + glow * 0.95)
    b = clamp(b + glow * 0.85)

    # Subtle vinyl groove concentric rings
    rad = math.hypot(u - 0.52, v - 0.52)
    for ring_r in (0.28, 0.35, 0.41):
        ring_a = (1.0 - smoothstep(0.0, 0.009, abs(rad - ring_r))) * 0.08
        r = r * (1.0 - ring_a) + 1.0 * ring_a
        g = g * (1.0 - ring_a) + 1.0 * ring_a
        b = b * (1.0 - ring_a) + 1.0 * ring_a

    # Inner glass border highlight
    border_a = (1.0 - smoothstep(0.0, 0.012, abs(d_bg + 0.010))) * (0.26 * (1.0 - v * 0.65))
    r = clamp(r + border_a)
    g = clamp(g + border_a)
    b = clamp(b + border_a)

    # Drop shadow under music note
    d_shadow = sd_music_note(u - 0.012, v - 0.022)
    shadow_a = (1.0 - smoothstep(-0.015, 0.035, d_shadow)) * 0.28
    r *= (1.0 - shadow_a)
    g *= (1.0 - shadow_a)
    b *= (1.0 - shadow_a)

    # Crisp white music note
    d_note = sd_music_note(u, v)
    note_a = 1.0 - smoothstep(-0.004, 0.004, d_note)
    if note_a > 0.0:
        nr, ng, nb = 0.99, 1.0, 0.995
        r = r * (1.0 - note_a) + nr * note_a
        g = g * (1.0 - note_a) + ng * note_a
        b = b * (1.0 - note_a) + nb * note_a

    return (r * alpha_bg, g * alpha_bg, b * alpha_bg, alpha_bg)


def render_png(size: int) -> bytes:
    samples = 4
    inv_s = 1.0 / samples
    inv_s2 = 1.0 / (samples * samples)
    rows = []

    for y in range(size):
        row = bytearray([0])  # Filter type 0 (None)
        for x in range(size):
            pr = pg = pb = pa = 0.0
            for sy in range(samples):
                v = (y + (sy + 0.5) * inv_s) / size
                for sx in range(samples):
                    u = (x + (sx + 0.5) * inv_s) / size
                    sr, sg, sb, sa = sample_color(u, v)
                    pr += sr
                    pg += sg
                    pb += sb
                    pa += sa
            pa *= inv_s2
            if pa <= 1e-5:
                row.extend((0, 0, 0, 0))
            else:
                pr = clamp((pr * inv_s2) / pa)
                pg = clamp((pg * inv_s2) / pa)
                pb = clamp((pb * inv_s2) / pa)
                row.extend((
                    int(round(pr * 255.0)),
                    int(round(pg * 255.0)),
                    int(round(pb * 255.0)),
                    int(round(clamp(pa) * 255.0)),
                ))
        rows.append(bytes(row))

    raw_data = b"".join(rows)

    def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw_data, level=9)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def main() -> None:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    ui_img_dir = os.path.join(base_dir, "app", "ui", "images")
    os.makedirs(ui_img_dir, exist_ok=True)

    png_64 = render_png(64)
    png_256 = render_png(256)

    targets = [
        (os.path.join(base_dir, "ICON.PNG"), png_64),
        (os.path.join(base_dir, "ICON_256.PNG"), png_256),
        (os.path.join(ui_img_dir, "icon_64.png"), png_64),
        (os.path.join(ui_img_dir, "icon_256.png"), png_256),
    ]
    for path, content in targets:
        with open(path, "wb") as f:
            f.write(content)
        print(f"Generated {path} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
