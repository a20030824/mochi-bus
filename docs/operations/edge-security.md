# Edge transport security runbook

Last verified: 2026-07-10 (Asia/Taipei)

## Required Cloudflare settings

| Setting | Required value | 2026-07-10 status |
| --- | --- | --- |
| SSL/TLS → Edge Certificates → Always Use HTTPS | On | Verified |
| SSL/TLS → Edge Certificates → Minimum TLS Version | TLS 1.2 | Verified |
| HSTS | Staged in Worker response first | Stage 1 active: `max-age=300` |

The Worker also returns a 308 redirect for non-local HTTP requests. This is defense in depth if the zone setting is accidentally disabled; Cloudflare's edge redirect remains the primary control.

## Verification commands

```powershell
curl.exe -I http://bus.moc96336.com/
curl.exe -I http://bus.moc96336.com/setup
curl.exe -I http://bus.moc96336.com/api/v1/map/cities
curl.exe -I https://bus.moc96336.com/

cmd /c "echo.| openssl s_client -connect bus.moc96336.com:443 -servername bus.moc96336.com -tls1 -cipher DEFAULT:@SECLEVEL=0 -brief 2>&1"
cmd /c "echo.| openssl s_client -connect bus.moc96336.com:443 -servername bus.moc96336.com -tls1_1 -cipher DEFAULT:@SECLEVEL=0 -brief 2>&1"
cmd /c "echo.| openssl s_client -connect bus.moc96336.com:443 -servername bus.moc96336.com -tls1_2 -brief 2>&1"
cmd /c "echo.| openssl s_client -connect bus.moc96336.com:443 -servername bus.moc96336.com -tls1_3 -brief 2>&1"
```

Expected results:

- Every HTTP path redirects to the same HTTPS path and query.
- TLS 1.0 and 1.1 fail with a protocol-version alert.
- TLS 1.2 and 1.3 establish a connection.
- HTTPS responses include `Strict-Transport-Security`, `Content-Security-Policy`, `Permissions-Policy`, `X-Content-Type-Options`, and anti-framing headers.

## HSTS rollout

HSTS is cached by browsers and is not instantly reversible. Increase it only after each observation period passes.

| Stage | Header | Minimum observation |
| --- | --- | --- |
| 1 | `max-age=300` | 24 hours |
| 2 | `max-age=86400` | 7 days |
| 3 | `max-age=2592000` | 30 days |
| 4 | `max-age=15552000` | Ongoing |

Do not add `includeSubDomains` until every subdomain has been inventoried and verified over HTTPS. Do not request browser preload until that audit is complete and the long-lived policy has been stable.

To advance a stage, update `HSTS_MAX_AGE_SECONDS` in `src/security.ts`, run the full project check, deploy, and repeat the live header and TLS checks above.

## Rollback

1. Roll the Worker back to the previous known-good deployment if the redirect or security headers break application behavior.
2. Cloudflare Always Use HTTPS may be disabled only as an emergency diagnostic action; restore it immediately after the incident is understood.
3. Lowering or removing HSTS affects only new responses. Clients that cached the previous header retain it until its `max-age` expires.
4. Do not disable Minimum TLS 1.2 unless an explicitly identified, approved legacy client requires a temporary exception.

## 2026-07-10 verification record

- Active deployment: `a564a2f5-05bc-42d1-9f1f-28bccc4ababf` (deployed at approximately 20:03 Asia/Taipei).
- Previous rollback version: `07015cfa-cca7-4cba-ada1-cf97fcdf897a`.
- `/`, `/setup`, and `/api/v1/map/cities` returned `301` with the equivalent HTTPS `Location`.
- TLS 1.0 and TLS 1.1 were rejected with alert 70 (`protocol_version`) when tested with OpenSSL security level 0.
- TLS 1.2 and TLS 1.3 connected successfully.
- The deployed Worker returns `Strict-Transport-Security: max-age=300`, a minimal enforced CSP, Permissions Policy, `X-Content-Type-Options`, and anti-framing headers.
- `/`, `/setup`, `/map`, cities, robots, manifest, and an intentional 404 passed the post-deploy smoke test.
- All 22 city route endpoints returned HTTP 200 after deployment.

## References

- [Cloudflare: Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
- [Cloudflare: Minimum TLS Version](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)
- [Cloudflare: HTTP Strict Transport Security](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/)
