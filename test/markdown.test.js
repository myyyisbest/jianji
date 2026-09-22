'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { render, renderInline, escapeHtml } = require('../js/markdown.js');

describe('escapeHtml', () => {
  it('escapes special HTML characters', () => {
    assert.equal(escapeHtml('a&b<c>"d\'e'), 'a&amp;b&lt;c&gt;&quot;d&#39;e');
  });
});

describe('renderInline link allowlist', () => {
  it('allows http / https / mailto', () => {
    const http = renderInline('[x](http://example.com)');
    const https = renderInline('[x](https://example.com/a)');
    const mail = renderInline('[x](mailto:a@b.c)');
    assert.match(http, /href="http:\/\/example\.com"/);
    assert.match(https, /href="https:\/\/example\.com\/a"/);
    assert.match(mail, /href="mailto:a@b\.c"/);
    assert.match(http, /rel="noopener noreferrer"/);
  });

  it('downgrades javascript: and other schemes to #', () => {
    const js = renderInline('[x](javascript:alert(1))');
    const data = renderInline('[x](data:text/html,hi)');
    assert.match(js, /href="#"/);
    assert.match(data, /href="#"/);
    assert.doesNotMatch(js, /javascript:/);
  });

  it('escapes HTML in text before applying marks', () => {
    const html = renderInline('<script>alert(1)</script>');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('render', () => {
  it('renders headings and code fences', () => {
    const html = render('# Hello\n\n```\n<a>\n```\n');
    assert.match(html, /<h1>Hello<\/h1>/);
    assert.match(html, /<pre><code>&lt;a&gt;<\/code><\/pre>/);
  });
});
