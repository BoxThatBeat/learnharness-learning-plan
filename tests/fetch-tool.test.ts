import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicUrl, createFetchTool, FETCH_LIMITS, fetchPublicText, htmlToText, isPrivateAddress } from "../src/fetch-tool.ts";

const publicResolver = async () => ["93.184.216.34"];

test("private, loopback, link-local and mapped addresses are recognized", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("URL admission refuses local targets, credentials and other schemes", async () => {
  await assert.rejects(assertPublicUrl("file:///etc/passwd", publicResolver), /http\(s\)/);
  await assert.rejects(assertPublicUrl("http://localhost:3000", publicResolver), /Local hostnames/);
  await assert.rejects(assertPublicUrl("http://user:pw@example.com", publicResolver), /credentials/);
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest", publicResolver), /Non-public/);
  await assert.rejects(assertPublicUrl("https://rebind.example", async () => ["10.0.0.5"]), /Non-public/);
  assert.equal((await assertPublicUrl("https://ocw.mit.edu/x", publicResolver)).hostname, "ocw.mit.edu");
});

test("redirects are re-validated on every hop", async () => {
  const fetchStub = (async (url: URL) => url.hostname === "start.example"
    ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })
    : new Response("secret", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
  await assert.rejects(fetchPublicText("https://start.example/", undefined, { fetch: fetchStub, resolve: publicResolver }), /Non-public/);
});

test("HTML is reduced to text, capped, and the per-task budget is enforced", async () => {
  assert.equal(htmlToText("<html><head><title>x</title><script>evil()</script></head><body><h1>Course</h1><ul><li>Circuits &amp; signals</li><li>RF&#33;</li></ul></body></html>"), "Course\n\n- Circuits & signals\n- RF!");
  const long = `<title>Syllabus</title><p>${"a".repeat(FETCH_LIMITS.maxChars + 500)}</p>`;
  const fetchStub = (async () => new Response(long, { headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
  const tool = createFetchTool({ fetch: fetchStub, resolve: publicResolver });
  const result = await tool.execute("c", { url: "https://uni.example/syllabus" });
  assert.match(result.content[0]!.text, /^Fetched https:\/\/uni\.example\/syllabus — Syllabus \(truncated\)/);
  assert.equal(result.details.truncated, true);
  for (let used = 1; used < FETCH_LIMITS.perTask; used++) await tool.execute("c", { url: "https://uni.example/syllabus" });
  await assert.rejects(tool.execute("c", { url: "https://uni.example/syllabus" }), /budget/);
  const binary = (async () => new Response("PDF", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
  await assert.rejects(fetchPublicText("https://uni.example/a.pdf", undefined, { fetch: binary, resolve: publicResolver }), /Unsupported content type/);
});
