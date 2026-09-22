/* ============================================================
   简记 · AWS SigV4 签名（零依赖，纯 Node crypto）
   供 server.js 的 S3 请求使用；也可单独 require 做单元测试。
   ============================================================ */
'use strict';

const crypto = require('crypto');

function sha256hex(b) {
  return crypto.createHash('sha256').update(b).digest('hex');
}

function hmac(key, buf) {
  return crypto.createHmac('sha256', key).update(buf).digest();
}

/**
 * 构建 S3 SigV4 签名头。
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.canonicalUri  已规范化的路径（含桶与对象）
 * @param {string} [opts.payload='']  请求体字符串（GET 为空串）
 * @param {string} opts.accessKeyId
 * @param {string} opts.secretAccessKey
 * @param {string} [opts.region='us-east-1']
 * @param {string} opts.host          Host 头（可含非默认端口）
 * @param {string} [opts.service='s3']
 * @param {Date}   [opts.date=new Date()]  可注入时钟以便测试
 * @returns {{ amzDate, dateStamp, payloadHash, signedHeaders, authorization, headers }}
 */
function signS3Headers({
  method,
  canonicalUri,
  payload = '',
  accessKeyId,
  secretAccessKey,
  region = 'us-east-1',
  host,
  service = 's3',
  date = new Date(),
}) {
  const payloadHash = sha256hex(payload);
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(h => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    amzDate,
    dateStamp,
    payloadHash,
    signedHeaders,
    authorization,
    signature,
    scope,
    headers: { ...headers, Authorization: authorization },
  };
}

module.exports = { sha256hex, hmac, signS3Headers };
