import { pooledMap } from "@std/async/pool";

import type {
  PutObjectRequest, PutObjectOutput,
  CreateMultipartUploadRequest, CreateMultipartUploadOutput,
  UploadPartRequest, UploadPartOutput,
  CompleteMultipartUploadRequest, CompleteMultipartUploadOutput,
  AbortMultipartUploadRequest, AbortMultipartUploadOutput,
  CompletedPart,
} from "../services/s3/structs.ts";
import type { ByteArray } from "../client/common.ts";

/**
 * Uploads a Uint8Array stream of unknown size to an Amazon S3 endpoint.
 *
 * The stream is buffered into chunks of fixed size (`partSize`, 5MB by default).
 * The chunks are uploaded as a new S3 Multi-part Upload and then finalized.
 * Multiple chunks can upload at the same time (`queueSize`, 4 by default).
 * This can result in faster uploads for larger files, compared to a single request.
 *
 * Objects smaller than 5MB skip the multi-part logic entirely and use `putObject` instead.
 *
 * Note that multi-part uploads require different IAM permissions than simple uploads.
 * Consider testing your application with files both above and below 5MB.
 */
export async function managedUpload(
  s3: S3Subset,
  params: CreateMultipartUploadRequest & {
    Body: ReadableStream<ByteArray>;
  },
  config?: {
    queueSize?: number;
    partSize?: number;
    leavePartsOnError?: boolean;
  },
): Promise<CompleteMultipartUploadOutput> {
  let uploadId: string | null = null;

  const queueSize = config?.queueSize ?? 4;
  const partSize = config?.partSize ?? (5*1024*1024);

  let startUploadCall: Promise<string> | null = null;
  async function uploadSegment(part: UploadPart) {
    if (part.seqNumber == 1 && part.isFinal) {
      // fast path: if object is smaller than partSize, simply upload in one go
      const response = await s3.putObject({...params, Body: part.payload});
      return { putObject: response };
    }
    if (!uploadId) {
      // Only want to call createMultipartUpload once
      if (!startUploadCall) {
        startUploadCall = s3.createMultipartUpload(params).then(x => x.UploadId ?? '');
      }
      uploadId = await startUploadCall;
    }
    if (!uploadId) throw new Error(`No S3 multipart UploadId received from server`);

    const partResp = await s3.uploadPart({
      ...params,
      UploadId: uploadId,
      PartNumber: part.seqNumber,
      Body: part.payload,
    });
    if (!partResp.ETag) throw new Error(`No S3 multipart segment ETag received from server`);
    return { uploadPart: {
      ETag: partResp.ETag,
      PartNumber: part.seqNumber,
    }};
  }

  try {
    // Actually process the stream and do the transfers
    const segments = params.Body.pipeThrough(newPartSegmenter(partSize));
    const partEtags = new Array<CompletedPart>();
    let putObjectResp: PutObjectOutput | null = null;
    for await (const part of pooledMap(queueSize, segments, uploadSegment)) {
      if (part.putObject) {
        // It would be cleaner to return here, but pooledMap doesn't like being canceled:
        // https://github.com/denoland/deno_std/issues/2197
        putObjectResp = part.putObject;
      } else {
        partEtags.push(part.uploadPart);
      }
    }
    if (putObjectResp) return putObjectResp;
    if (!uploadId) throw new Error(`BUG: No S3 multipart operation was started.`);

    // Finish up
    return await s3.completeMultipartUpload({
      ...params,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: partEtags.sort((a,b) => a.PartNumber! - b.PartNumber!),
      },
    });

  } catch (err) {
    // Before bubbling any errors up, we'll quietly try to clean up after ourselves
    // Half-completed multipart uploads stick around by default (and consume storage) otherwise
    if (uploadId && !config?.leavePartsOnError) {
      await s3.abortMultipartUpload({
        ...params,
        UploadId: uploadId,
      }).catch(() => {});
    }
    throw err;
  }
}

interface UploadPart {
  seqNumber: number;
  payload: ByteArray;
  isFinal: boolean;
}
export function newPartSegmenter(partSize: number): TransformStream<ByteArray, UploadPart> {
  let currentPart = new Uint8Array(partSize);
  let byteOffset = 0;
  let nextPartNum = 1;
  return new TransformStream<ByteArray, UploadPart>({
    transform(chunk, ctlr) {
      let remaining = chunk;
      while (remaining.byteLength > (currentPart.byteLength - byteOffset)) {
        const left = remaining.subarray(0, currentPart.byteLength - byteOffset);
        remaining = remaining.subarray(left.byteLength);
        currentPart.set(left, byteOffset);
        ctlr.enqueue({
          seqNumber: nextPartNum++,
          payload: currentPart,
          isFinal: false,
        });
        currentPart = new Uint8Array(partSize);
        byteOffset = 0;
      }
      if (remaining.byteLength > 0) {
        currentPart.set(remaining, byteOffset);
        byteOffset += remaining.byteLength;
      }
    },
    flush(ctlr) {
      if (byteOffset > 0) {
        ctlr.enqueue({
          seqNumber: nextPartNum++,
          payload: currentPart.subarray(0, byteOffset),
          isFinal: true,
        });
      } else if (nextPartNum == 1) {
        // Always emit at least one part
        ctlr.enqueue({
          seqNumber: nextPartNum++,
          payload: new Uint8Array(0),
          isFinal: true,
        });
      }
    },
  });
}

interface S3Subset {
  /** Uploads an object to a bucket in one go. */
  putObject(params: PutObjectRequest): Promise<PutObjectOutput>;
  /** Initiates a multipart upload and returns an upload ID. */
  createMultipartUpload(params: CreateMultipartUploadRequest): Promise<CreateMultipartUploadOutput>;
  /** Adds a part in a multipart upload. */
  uploadPart(params: UploadPartRequest): Promise<UploadPartOutput>;
  /** Completes a multipart upload by assembling previously uploaded parts. */
  completeMultipartUpload(params: CompleteMultipartUploadRequest): Promise<CompleteMultipartUploadOutput>;
  /** Aborts a multipart upload. */
  abortMultipartUpload(params: AbortMultipartUploadRequest): Promise<AbortMultipartUploadOutput>;
}
