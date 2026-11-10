#!/usr/bin/env bun
import { BunCrypto, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { main } from "./main.ts";

BunRuntime.runMain(
  main.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layerDigest))),
);
