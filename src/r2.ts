// R2 bucket listing via the S3-compatible API (ListBuckets), signed with
// AWS SigV4. Used as a fallback when the Cloudflare API path is not
// permitted; requires an R2 access key pair (R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY).

import crypto from "node:crypto";

export interface R2BucketInfo {
  name: string;
  creation_date: string | null;
}

const sha256hex = (data: string) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();

export async function r2ListBuckets(
  accountId: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<R2BucketInfo[]> {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex("");

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["GET", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  let signingKey: crypto.BinaryLike = `AWS4${secretAccessKey}`;
  for (const part of [dateStamp, "auto", "s3", "aws4_request"]) {
    signingKey = hmac(signingKey, part);
  }
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}/`, {
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`R2 S3 API returned HTTP ${res.status}`);
  const xml = await res.text();

  const buckets: R2BucketInfo[] = [];
  const re = /<Bucket>([\s\S]*?)<\/Bucket>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = /<Name>([^<]+)<\/Name>/.exec(m[1])?.[1];
    if (!name) continue;
    const creationDate = /<CreationDate>([^<]+)<\/CreationDate>/.exec(m[1])?.[1] ?? null;
    buckets.push({ name, creation_date: creationDate });
  }
  return buckets;
}
