# ADR-007 — Java Spider is optional sidecar compatibility

## Status
Accepted and extended in V1.2.

## Decision
Java JAR compatibility is not part of the core V1.0 runtime and must never be loaded into Renderer/Main. V1.2 adds an optional independent JVM SpiderHost communicating through a text protocol.

## Boundary
The host targets common pure-JVM CatVod reflection methods. Android/DexClassLoader-dependent JARs are not promised as 100% compatible.
