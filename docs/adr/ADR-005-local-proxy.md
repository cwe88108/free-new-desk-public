# ADR-005 — Loopback media proxy

## Status
Accepted.

## Decision
Use an authenticated local proxy bound only to `127.0.0.1` on a random port. A random bearer token protects every proxy request.

## Responsibilities
Forward required media headers/cookies, rewrite HLS playlists and nested URI attributes, proxy segments, and convert supported subtitle formats such as SRT to WebVTT. Never bind to `0.0.0.0`.
