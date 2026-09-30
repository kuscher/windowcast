#!/usr/bin/env python3
"""Render the Windowcast icons as PNGs with signed-distance anti-aliasing (no dependencies).

Two overlapping rounded windows on a blue tile: a window arriving from another device.
Run from chromebook/: python3 tools/make_icons.py
"""
import math, struct, zlib, pathlib

BLUE = (11, 87, 208)      # Material 3 primary blue
WHITE = (255, 255, 255)

def sd_round_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r

def cov(d):
    return min(1.0, max(0.0, 0.5 - d))

def render(size, maskable=False):
    s = float(size)
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            # background tile
            if maskable:
                a_bg = 1.0
            else:
                a_bg = cov(sd_round_rect(px, py, s / 2, s / 2, s / 2, s / 2, 0.22 * s))
            k = 0.78 if maskable else 1.0          # keep the glyph inside the maskable safe zone
            gx = s / 2 + (px - s / 2) / k
            gy = s / 2 + (py - s / 2) / k
            sw = max(0.055 * s, 1.1)               # stroke width, at least ~1px on the 16px icon
            # back window (offset up-left, translucent)
            d_back = abs(sd_round_rect(gx, gy, 0.44 * s, 0.42 * s, 0.25 * s, 0.19 * s, 0.05 * s)) - sw / 2
            a_back = cov(d_back) * 0.45
            # front window outline plus a filled title bar
            fcx, fcy, fhw, fhh = 0.56 * s, 0.58 * s, 0.27 * s, 0.205 * s
            d_front = abs(sd_round_rect(gx, gy, fcx, fcy, fhw, fhh, 0.055 * s)) - sw / 2
            bar_h = 0.1 * s
            d_bar = sd_round_rect(gx, gy, fcx, fcy - fhh + bar_h / 2, fhw, bar_h / 2, 0.04 * s)
            # knock the back window out where the front window's body is, so they don't blend into a blob
            inside_front = cov(sd_round_rect(gx, gy, fcx, fcy, fhw + sw / 2, fhh + sw / 2, 0.055 * s))
            a_back *= (1.0 - inside_front)
            a_glyph = max(cov(d_front), cov(d_bar), a_back)
            r = BLUE[0] * (1 - a_glyph) + WHITE[0] * a_glyph
            g = BLUE[1] * (1 - a_glyph) + WHITE[1] * a_glyph
            b = BLUE[2] * (1 - a_glyph) + WHITE[2] * a_glyph
            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a_bg * 255 + 0.5)))
        rows.append(bytes(row))
    return rows

def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    pathlib.Path(path).write_bytes(png)

if __name__ == "__main__":
    for n in (16, 32, 48, 128):
        write_png(f"extension/icons/icon-{n}.png", n, render(n))
    for n in (32, 192, 512):
        write_png(f"viewer/icons/icon-{n}.png", n, render(n))
    write_png("viewer/icons/maskable-512.png", 512, render(512, maskable=True))
    print("icons written")
