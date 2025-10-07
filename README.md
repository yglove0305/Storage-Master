```markdown
# LocalStorage Master (LSM) — 상세 설명서

이 문서는 main.js에 있는 "LocalStorage Master (LSM)" JavaScript 라이브러리의 코드 구조, 설계 철학, 주요 구성 요소, 상호작용 방식, 사용법 및 주의사항을 자세히 설명합니다. 이 라이브러리는 브라우저의 localStorage(또는 제공된 스토리지 프로바이더)를 고수준으로 확장해 안전성, 대용량 지원, 압축/암호화, 인덱싱, 트랜잭션 유사 동작 등을 제공하려는 목적을 갖고 있습니다.

목차
- 개요
- 주요 목표와 한계
- 빠른 시작 (예제)
- 핵심 개념 및 네이밍 규칙
- 주요 컴포넌트 설명
  - 스토리지 추상화 (LSM_Storage)
  - 이벤트 버스 (LSM_EventBus)
  - Broadcast/동기화 (LSM_Channel)
  - 저널 (LSM_Journal)
  - 인덱스 (LSM_IndexStore)
  - 잠금 (LSM_Lock)
  - 메트릭 (LSM_Metrics)
  - 압축 (LSM_LZW)
  - 암호화 (LSM_Crypto)
- 핵심 API (LocalStorageMaster)
  - 생성/초기화 파이프라인
  - set / get / remove / has
  - batch, transaction, index, export/import 등
- 고수준 편의 API
  - LSM_Collection, LSM_DocumentStore, LSM_Cache, LSM_Queue, LSM_PubSub
- 내부 직렬화/청크 전략
- 동시성, 교차 탭, 원자성(제약)
- 오류 처리, 복구, 저널링
- 보안 관련 주의점
- 성능 및 운영 고려사항
- 확장 포인트와 권장 사용법
- FAQ / 문제 해결 팁
- 라이선스 및 참고

---

## 개요

LocalStorage Master(LSM)는 브라우저(또는 localStorage-like 제공자) 기반 스토리지에 복잡한 데이터와 대용량 페이로드를 안정적으로 저장하기 위한 고수준 라이브러리입니다. 주요 기능은 다음과 같습니다:

- 네임스페이스 지원으로 데이터 분리
- 대용량 데이터 분할(shard/chunk)
- LZW 압축 (선택)
- AES-GCM 기반 암호화 (WebCrypto 사용 가능 시) / XOR 폴백
- TTL(만료) 및 정기 vacuum(청소)
- 간이 트랜잭션(저널 + 롤백 시도)
- 교차 탭 동기화(BroadcastChannel 또는 storage 이벤트)
- 보조 인덱스 및 간단한 쿼리
- LRU/LFU 기반 강제 삭제(eviction)
- 스냅샷(export/import) 및 백업
- 이벤트 관찰자 및 진단/메트릭

이 라이브러리는 localStorage의 동기적이고 제한적인 특성을 보완하려 시도하지만, "브라우저 환경의 근본적인 제약(동시성/원자성 한계)"을 완전히 제거할 수는 없음을 명시합니다.

---

## 주요 목표와 한계

명시된 목표
- 안전하고 사용하기 쉬운 로컬 스토리지 레이어 제공
- 큰 객체 저장 지원(청크 단위로 분할)
- 압축/암호화 기반 선택적 보호
- TTL과 백그라운드 정리
- 트랜잭션과 저널을 통한 롤백 시도
- 교차 탭(multi-tab) 동기화 지원

한계
- localStorage 자체가 제공하는 원자성 보장은 없음 (동시성 문제 존재)
- 브라우저 제한(키/값 길이, 총 저장량)에 의해 동작 영향
- XOR 폴백 암호화는 보안적이지 않음(데모/비밀 보호 불가)
- 완전한 ACID 보장 없음 — best-effort

---

## 빠른 시작 (예제)

```javascript
// 인스턴스 생성
const lsm = LocalStorageMaster.create({
  namespace: 'myApp',
  compress: true,
  encrypt: true,
  shardSize: 64 * 1024,
  vacuumInterval: 30_000,
});

// 초기화 대기
await lsm.ready();

// 단일 키 저장
await lsm.set('settings', { theme: 'dark', lang: 'en' }, { ttl: 86_400_000 });

// 읽기
const settings = await lsm.get('settings');

// 컬렉션 사용
await lsm.createIndex('byRole');
const users = new LSM_Collection(lsm, 'users', { indexes: [{ name: 'byRole', field: 'role' }] });
await users.put('u1', { name: 'Ada', role: 'admin' });
const admins = await users.findByIndex('byRole', 'admin');
```

---

## 핵심 개념 및 네이밍 규칙

- 네임스페이스: cfg.namespace로 격리. 모든 키는 prefix + namespace로 시작.
- 키네이밍
  - marker(원 키): `${prefix}:${namespace}:${userKey}` — 목록/비교용 마커
  - 메타: `${prefix}:${namespace}:${metaPrefix}:${userKey}` — 메타데이터(JSON)
  - 청크: `${prefix}:${namespace}:${userKey}:chunk:${i}` — 0..N-1 청크
  - 인덱스: `${prefix}:${namespace}:${indexPrefix}:${indexName}` — 보조 인덱스 저장
- 내부 레코드(meta) 구조:
  - created, updated, ttl, expiresAt, compressed, encrypted, chunks, size, lru, lfu, indexKeys, schemaVersion

---

## 주요 컴포넌트 설명

아래는 main.js에 구현된 주요 클래스들의 요약입니다.

### LSM_Storage
- localStorage (또는 Memory shim, 또는 사용자 제공 storageProvider) 래퍼.
- getItem/setItem/removeItem/key/length/clear 같은 localStorage-like API를 표준화.

### LSM_EventBus
- 단순한 이벤트 발행/구독 구현.
- 내부/외부 액션(예: set/get/remove/remote:set 등)에 대해 이벤트를 방출.

### LSM_Channel
- BroadcastChannel을 사용하여 교차 탭 메시징 제공.
- BroadcastChannel이 없으면 localStorage 이벤트(fallback)를 사용.
- post(message)로 메시지를 브로드캐스트(브로드캐스트용 임시 키를 localStorage에 쓰고 지움).
- post 호출 시 channel.postMessage 또는 임시 localStorage 쓰기/삭제를 사용.

### LSM_Journal
- 트랜잭션/롤백을 위해 간단한 배열 형태의 저널을 `${prefix}:${namespace}:__journal__`에 저장.
- append, read, write, clear 기능 제공.

### LSM_IndexStore
- 보조 인덱스(간단한 fieldValue -> [key,...] 맵)를 인메모리처럼 로컬스토리지에 유지.
- index 이름별로 JSON 객체를 읽고 쓰며, ensureEntry/removeEntry/query/list 제공.

### LSM_Lock
- 교차 탭 락(베어본). localStorage에 락키를 기록하고 소유자/만료(leaseMs) 검사.
- acquire: 시도 반복 후 성공/실패 boolean 반환.
- release: 소유자면 락 제거.
- 완전한 원자성 제공 불가, best-effort.

### LSM_Metrics
- 간단한 카운터/타이머/샘플 수집기로 성능 진단에 도움.

### LSM_LZW
- 문자열 기반 LZW 압축/해제 구현. 내부적으로 정수 시퀀스를 Uint16Array로 변환하고 Base64로 인코딩.
- 참고: 구현상 제한사항/edge cases 존재 가능(특히 넓은 유니코드, 이진 데이터 등).

### LSM_Crypto
- WebCrypto 사용 가능시 AES-GCM 256 생성/내보내기/가져오기/암복호화 제공.
- WebCrypto 불가 환경에서는 "XOR" 폴백을 사용(보안 취약, 데모용).
- encrypt: 입력을 문자열로 변환 → AES-GCM(IV 포함) → IV + cipher 합쳐서 Base64 반환.
- decrypt: Base64 -> 분해 -> AES-GCM 복호화.
- IV 길이는 12바이트로 고정.

---

## 핵심 API: LocalStorageMaster

LocalStorageMaster는 핵심 라이프사이클과 주요 작업을 담당합니다.

생성 및 초기화
- LocalStorageMaster.create(cfg) — 생성자 래퍼.
- ready() / init() — 암호화 키 준비(옵션), vacuum 스케줄 시작, 필요한 초기화 수행.

데이터 저장/읽기/삭제
- set(userKey, value, opts)
  - 옵션: ttl, encrypt(우선순위), compress, indexes(인덱스 스펙 배열)
  - 시리얼라이즈 -> (선택적) 압축 -> (선택적) 암호화 -> 청크화 -> 청크 저장 + 메타 저장 + 마커 키 저장
  - journaling 옵션에 따라 SET_BEGIN/SET_END을 저널에 기록
  - lock.acquire로 간단한 상호배제 시도
  - index 업데이트, 브로드캐스트, 이벤트 emit
  - 실패 시 rollback: 작성한 청크/메타/마커 제거 + 저널에 롤백 항목 추가

- get(userKey, defaultValue, opts)
  - marker 확인 -> meta 읽기 -> TTL 검사(만료 시 remove 호출)
  - 청크를 모두 읽어 합치고 문자열로 변환
  - (선택적) 암호화 해제 -> (선택적) 압축 해제 -> JSON parse
  - 메타의 lru/lfu 갱신, metrics 증가, 이벤트 emit

- has(userKey)
  - marker 존재 여부

- remove(userKey)
  - meta에서 chunk 수 확인 -> 모든 청크 제거, meta 제거, 마커 제거
  - 인덱스 참조 제거
  - journaling, 브로드캐스트, 이벤트

Bulk API
- setMany, getMany, removeMany — 단순 for-loop 기반 구현

Transaction
- transaction(fn)
  - 락(일정 시도) 획득 후, 콜백에 tx 객체 전달.
  - tx.set/get/remove는 기본적으로 LSM의 set/get/remove를 호출(낙관적 접근)
  - rollback 구현은 저널을 거꾸로 읽어 SET_BEGIN을 찾아 제거하는 naive 구현

인덱스
- createIndex, dropIndex, queryIndex, listIndex : LSM_IndexStore 사용

백업/내보내기
- export({includeIndexes}) : namespace 접두사를 가진 모든 키를 스냅샷으로 수집
- import(snapshot, {overwrite}) : 스냅샷 내 데이터를 저장(락 사용)
- downloadBackup : 브라우저에서 다운로드 가능(blob 사용)

영속성/할당량/정리
- estimateNamespaceSize() : 현재 네임스페이스 크기 추정
- vacuum() : 만료된 항목 제거
- _maybeEvict() : quotaSoftLimit을 초과할 경우 _pickEvictionCandidate를 통해 LRU/LFU 기반으로 항목 제거

진단
- getMetrics(), listKeys(), getMeta(userKey)

마이그레이션
- migrate(targetVersion, adapter) : adapter.up(meta, value) => {meta, value} 를 사용해 항목을 신규 스키마로 갱신

내부 메서드
- _listRawKeys() : storage.key를 순회해 모든 키 수집
- _broadcast(msg) / _onBroadcast(msg) : 채널을 통한 메시지 송수신

---

## 고수준 편의 API

이 파일에는 LocalStorageMaster 상단에서 편리하게 사용할 수 있는 고수준 클래스들이 포함되어 있습니다.

LSM_Collection
- 컬렉션 네임스페이스 기반 CRUD 추상화(문서 id 포함)
- indexes 옵션을 받아 set 시 해당 인덱스를 갱신

LSM_DocumentStore
- LSM_Collection과 유사하나 스키마 검증(LSM_Schema)을 강제 가능
- schema 옵션을 통해 필수 필드/타입 검증

LSM_Cache
- 캐시 용으로 네임스페이스(`cache:${key}`)를 사용
- TTL, 압축, 암호화, 정책(LRU 등) 지정 가능

LSM_Queue
- 작업 큐: `queue:${id}` 항목들을 enqeue/dequeue/ack 방식으로 관리
- 단순 구현으로 완전한 FIFO 보장을 보장하지 않음(여러 한계 존재)

LSM_PubSub
- localStorage 기반 pub/sub 메시징(채널 네임 사용)
- remote:set을 구독해 특정 접두사로 온 메시지를 처리

LSM_Schema
- 가벼운 스키마 검증(필수 필드 및 타입 검사)

---

## 내부 직렬화와 청크 전략

직렬화
- 값은 먼저 JSON.stringify(LSM_safeStringify)를 통해 문자열화.
- 구조복사 등에서는 structuredClone 사용 가능 시 사용.

압축(LZW)
- LSM_LZW.compress: 문자열 -> LZW 정수 시퀀스 -> Uint16Array -> Uint8Array.buffer -> Base64
- LSM_LZW.decompress: Base64 -> Uint8Array -> Uint16Array -> LZW 역변환
- 주의: LZW 구현은 문자열 기반이며 넓은 유니코드나 비정형 이진데이터에 주의를 요함.

암호화(WebCrypto)
- AES-GCM 사용 가능 시 256-bit 키 생성 및 raw를 storage에 Base64로 보관
- 암호화 시 IV(12바이트)를 앞에 붙여 저장(IV + cipher -> Base64)
- WebCrypto 불가 환경에서는 XOR 기반 폴백(보안성 없음)

청크링
- payload 문자열을 TextEncoder로 바이트로 변환 후 shardSize(기본 128KB)로 잘라서 chunk i로 저장.
- meta.chunks에 청크 수를 기록.
- 읽을 때 모든 청크를 불러와 합친 후 TextDecoder로 디코딩.

---

## 동시성, 교차 탭, 원자성(제약)

- localStorage는 브라우저 내에서 동기적이지만 탭 간 원자성을 보장하지 않음.
- 교차 탭 동기화는 BroadcastChannel(권장) 또는 localStorage 이벤트를 통해 브로드캐스트 메커니즘을 사용.
- LSM_Lock는 간단한 lease 기반 락을 localStorage에 저장해 경쟁을 줄이려 함. 완전 동기화/원자성은 보장하지 않음.
- set 시 청크를 다 쓰고 메타/마커를 쓰는 순서로 작성되며, 불완전한 상태가 발생할 수 있어 get은 마커/메타/청크의 존재를 검증하고 복구(또는 default 반환)함.
- 트랜잭션은 락 획득 & 저널 참조를 통해 best-effort 롤백을 시도하지만, 원자성/격리성 보장은 제한적.

---

## 오류 처리, 복구, 저널링

- journaling 옵션이 켜져 있으면(기본 true) 주요 작업 시작/종료/롤백 이벤트를 journal에 append.
- set 실패 시 이미 쓴 청크/메타를 제거해 롤백 시도.
- transaction에서 예외 발생 시 naive rollback을 수행 (저널을 거꾸로 읽고 SET_BEGIN 발견 시 해당 키 삭제).
- vacuum()는 만료된 항목을 찾아 제거하며, 주기적으로 스케줄되어 stale 항목 청소를 수행.

---

## 보안 관련 주의점

- AES-GCM이 사용 가능하면 안전한 암호화를 제공하나 키를 localStorage에 raw(Base64)로 저장함. 이는 해당 스토리지에 접근 가능한 모든 스크립트/확장자에게 노출될 수 있으므로 민감한 키 저장에는 적합하지 않습니다.
- WebCrypto가 없는 환경에서 사용하는 XOR 폴백은 절대 보안용이 아님.
- 암호화 필요 시, 가능하면 안전한 키 관리(서버에서 키를 전달하거나, 사용자 비밀번호 기반 키 파생 등)를 고려하세요.
- 브라우저 확장/악성 스크립트가 주입되면 localStorage와 이 라이브러리로 저장된 데이터는 안전하지 않습니다.

---

## 성능 및 운영 고려사항

- shardSize 기본값은 128KB: localStorage의 항목 크기 제한/브라우저별 차이를 고려해 조정하세요.
- 대용량 항목을 자주 쓰면 동기적 localStorage 쓰기 때문에 UI 차단/지연을 초래할 수 있음. 가능한 비동기 처리/백그라운드로 분산하세요.
- 압축(LZW)은 CPU 비용을 유발. 자주 읽는 작은 데이터에는 압축을 끄는 것이 낫습니다.
- 암호화/복호화 (AES-GCM)은 WebCrypto에서 비동기적이지만 비용이 있으니 빈번한 작업엔 영향이 있습니다.
- estimateNamespaceSize는 모든 키를 순회하므로 큰 네임스페이스에서 비용이 큽니다. 빈번히 호출하지 마세요.

---

## 확장 포인트와 권장 사용법

확장:
- storageProvider: NodeJS 테스트용 또는 커스텀 스토리지를 주입 가능.
- migration adapter: migrate API로 inline 변환 로직을 제공.
- 인덱스/쿼리: 현재는 간단한 인덱스만 제공하므로 복잡한 쿼리는 외부 인덱싱을 사용하세요.
- 브로드캐스트: BroadcastChannel을 직접 사용해 더 세밀한 동기화 정책을 작성 가능.

권장 사용법:
- 민감 데이터는 서버에서 관리하거나, 키 관리를 신중히 설계.
- 대용량 항목은 덩어리를 잘게 나누고 shardSize 조정.
- vacuumInterval과 quota 한계(quotaSoftLimit/HardLimit) 설정으로 공간 관리를 자동화.
- 인덱스는 필요한 필드에만 만들고 주기적으로 재빌드/청소.

---

## FAQ / 문제 해결 팁

- "청크가 누락되어 get이 null을 반환하는 경우"
  - set 중 실패로 청크 일부만 남았을 가능성. 솔루션: journaling을 이용한 복구, 또는 export/import로 복원.
- "브로드캐스트가 동작하지 않음"
  - BroadcastChannel 지원 여부 확인, fallback으로 storage 이벤트를 사용하나 일부 브라우저 환경(예: 동일 탭)에서는 동작이 다를 수 있음.
- "암호화가 복호화 실패"
  - 키(raw) 손상 또는 잘못된 keyObj 사용 가능. key store key(`${prefix}:${namespace}:__key__`)가 올바른지 확인.
- "LRU/LFU 정책이 의도대로 동작하지 않음"
  - 메타가 제대로 갱신되지 않았거나 vacuum/eviction 호출 시점에서 메타를 읽어 결정하므로 race 상황을 고려.

---

## 예시: 트랜잭션 사용(간단)

```javascript
await lsm.transaction(async (tx) => {
  const cnt = await tx.get('counter', 0);
  await tx.set('counter', cnt + 1);
});
```

실제 트랜잭션은 내부적으로 락을 획득하고, set/remove 시 저널을 남겨 실패 시 롤백을 시도합니다. 완전한 분리성/원자성은 보장하지 않으므로 설계 시 주의가 필요합니다.

---

## 테스트 및 배포 권장사항

- 브라우저별 localStorage 용량/동작 테스트
- 대용량 payload에 대한 압축/복호화 성능 테스트
- 크로스-탭 시나리오(동시 쓰기, race condition) 테스트
- 암호화가 필요한 사용 사례는 키 관리와 함께 E2E 테스트
- node 테스트 환경에서는 storageProvider로 메모리 shim 제공

---

## 라이선스

- 상단 주석에 명시된 대로 MIT 라이선스(라이선스 텍스트는 저장소 루트에서 확인 가능).

---

끝으로, 저는 main.js 파일을 분석하여 위와 같은 구조화된 설명 문서를 만들었습니다. 이 문서는 개발자 도큐먼트나 README로 바로 옮길 수 있으며, 필요하시면 다음 작업을 도와드릴 수 있습니다:
- 문서의 영어 번역 또는 README로 통합
- 주요 함수별 유닛 테스트(suite) 템플릿 생성
- 실제 사용 예제(브라우저 샘플 앱) 추가
- 보안 개선(키 관리/암호화 개선) 제안 및 패치 구현

