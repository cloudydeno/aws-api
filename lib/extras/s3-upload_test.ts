import { just } from "@cloudydeno/stream-observables/sources/just";
import { collect } from "@cloudydeno/stream-observables/sinks/collect";
import { map } from "@cloudydeno/stream-observables/transforms/map";
import { assertEquals } from "@std/assert/equals";

import { newPartSegmenter } from "./s3-upload.ts";

/** Tests the logic which buffers a continuous stream into numbered parts */
Deno.test('newPartSegmenter()', async (t) => {

  // Streams and text encoding helper, so tests deal with simple string arrays
  const segmentStrings = (opts: {
    maxSize: number,
    inputChunks: string[],
  }) => collect(just(...opts.inputChunks)
    .pipeThrough(new TextEncoderStream())
    //              v-- The subject of the tests
    .pipeThrough(newPartSegmenter(opts.maxSize))
    .pipeThrough(map(x => ({ ...x,
      // This would break some unicode, fortunately the test cases are ASCII
      payload: new TextDecoder().decode(x.payload),
    }))));

  await t.step('cuts one segment up', async () => {
    assertEquals(await segmentStrings({
      maxSize: 4,
      inputChunks: ['1234567890'],
    }), [
      {seqNumber: 1, isFinal: false, payload: '1234'},
      {seqNumber: 2, isFinal: false, payload: '5678'},
      {seqNumber: 3, isFinal: true, payload: '90'},
    ]);
  });

  await t.step('recombines small segments', async () => {
    assertEquals(await segmentStrings({
      maxSize: 8,
      inputChunks: ['12', '34', '56', '78', '90'],
    }), [
      {seqNumber: 1, isFinal: false, payload: '12345678'},
      {seqNumber: 2, isFinal: true, payload: '90'},
    ]);
  });

  await t.step('handles exact fits', async () => {
    assertEquals(await segmentStrings({
      maxSize: 5,
      inputChunks: ['12345'],
    }), [
      // The first part should be 'final', to indicate that no Multi-Part setup is needed
      {seqNumber: 1, isFinal: true, payload: '12345'},
    ]);
  });

  await t.step('handles off-by-one fits', async () => {
    assertEquals(await segmentStrings({
      maxSize: 5,
      inputChunks: ['123456'],
    }), [
      {seqNumber: 1, isFinal: false, payload: '12345'},
      {seqNumber: 2, isFinal: true, payload: '6'},
    ]);
  });

  await t.step('emits empty part on empty input', async () => {
    // This behavior allows for uploading zero-length objects
    assertEquals(await segmentStrings({
      maxSize: 5,
      inputChunks: [],
    }), [
      {seqNumber: 1, isFinal: true, payload: ''},
    ]);
  });
});
