# D10 client-library provenance — @promptbranch/team-client

Vendored for the G2/G3 real-client gates (same artifact-based handoff as
the D0 contract; the main repo is never modified in place).

- Source repository: /Users/shai/Desktop/Code/china/PromptBranch
- Source commit: 64efdca17a38e870f7a70e4fb1e22a2f12f9338f (💄 feat(desktop): add team workspace navigation and catalogue)
- Version: 0.1.0 (source-exported package; its `@promptbranch/team-contract`
  workspace dependency resolves to this portal's vendored D0 copy)
- Intentional adaptations (recorded here, nothing else touched):
  package.json `private: true` (consumed via workspace:*; publishing stays
  the main repo's release action), and tsconfig.json gains lib DOM — this
  repo's shared tsconfig.base carries only ES2022, while the stream-reader
  types (ReadableStreamReadResult) need DOM; the vendored package's own
  config is the right scope for that

Per-file sha256 manifest:

80f89c70109ee9cf9ddf6372b740e7b9d1e0f3d75c6304da05b05de273039026  package.json
35cf9f3bf983b478bbb99c420f8fabf00def100ed7286f62a9b7697329ca6101  tsconfig.json
73105c1f5a2ca3e53da4ac4e965c441533529505dcd53bc700d08c356e09f7df  vitest.config.ts
006ff614dbb83e560b50edcf7f456ad5938c0864faf54628055ccd40a7976625  src/cache-adapter.ts
d6e02ae5c9bb16400bccb16c501fe4814a12b43b7d323fd31b09e0b5541d1439  src/client.ts
ab0172af4899d8fef16c6758f1ca228f1110ab0b25892287bb95f6dd931c6167  src/errors.ts
e79ea2c296c6ee1ac15fa86aa2bd2ec89dfde3e33fb96e030bba17dbcc39a455  src/index.ts
e6408ef3aefe17fe648943a55fd181760126ee14b27d09a7c6757d9080ad5325  src/oidc.ts
67c41798c2008221673824de7d1f0a24e1967c6701b7644b162044d2f002f75a  src/origin.ts
610b0c597a103fa2e83f6c26e6707fdfb701b47fa4585c8025aec0c765024144  src/sync.ts
cd049683acd5ff05d2076848f53526653fddd325378558c1a81c0beb390545db  src/transport.ts
2891d1a6d9aa5cd69cfd1bbebeff7a9a5872410a7a11e48bfed291630e65aa77  tests/cache-adapter.test.ts
5ec2012ad1339cbddef33478611760162806da1c6317952fa5e47d332227d9ff  tests/client.test.ts
2148ee6a8c2fe66982fcf3a13b65158427da269986fc72bd6e3c4a047cb8197a  tests/oidc.test.ts
04a13dffb799cf84c851dc8537b3d02daaea579eaa3f4cf9c794c329cb0d190e  tests/origin.test.ts
a8889434e9b0acffb1ba2b3bbe5efcf631dcce92ab732406814358dc91d82c79  tests/sync.test.ts
304d73dc91177a79b8e92931d3622a28f22bde3bd1bb19ebbc776c01e2e1b6e6  tests/transport.test.ts
