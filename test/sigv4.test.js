'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sha256hex, hmac, signS3Headers } = require('../lib/sigv4');

describe('sha256hex / hmac', () => {
  it('hashes empty string to known SHA-256', () => {
    assert.equal(
      sha256hex(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hmac returns a Buffer', () => {
    const out = hmac('key', 'msg');
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.length, 32);
  });
});

describe('signS3Headers', () => {
  const fixedDate = new Date('2020-01-01T00:00:00.000Z');
  const base = {
    method: 'GET',
    canonicalUri: '/my-bucket/notes.json',
    payload: '',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    host: 's3.amazonaws.com',
    date: fixedDate,
  };

  it('is deterministic for fixed clock + inputs', () => {
    const a = signS3Headers(base);
    const b = signS3Headers(base);
    assert.equal(a.signature, b.signature);
    assert.equal(a.authorization, b.authorization);
    assert.equal(a.amzDate, '20200101T000000Z');
    assert.equal(a.dateStamp, '20200101');
    assert.equal(
      a.signature,
      '1d9fd517c170c4d08c1a24497c4451c8999d3a159e62f84f08b7552730f04520',
    );
    assert.equal(
      a.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20200101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=1d9fd517c170c4d08c1a24497c4451c8999d3a159e62f84f08b7552730f04520',
    );
  });

  it('changes signature when secret or payload changes', () => {
    const a = signS3Headers(base);
    const b = signS3Headers({ ...base, secretAccessKey: 'different-secret' });
    const c = signS3Headers({ ...base, method: 'PUT', payload: '{"x":1}' });
    assert.notEqual(a.signature, b.signature);
    assert.notEqual(a.signature, c.signature);
    assert.match(c.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(c.headers.host, 's3.amazonaws.com');
  });
});
