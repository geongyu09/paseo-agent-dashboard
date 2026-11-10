# 에이전트 보드 (Paseo 플러그인)

Paseo의 워크스페이스 패널 「에이전트 보드」(영어 이름 Agent board)를 만드는 플러그인이며, npm 패키지 `@geongyu09/paseo-agent-dashboard`로 배포합니다. 플러그인 id는 `paseo-agent-dashboard`이고, 이 컴퓨터의 데몬에는 이 폴더 경로로 설치되어 있습니다. 기능 설명은 `OVERVIEW.md`(영어)와 `OVERVIEW.zh-CN.md`(중국어 간체)에 있으며, 기능을 바꾸면 두 파일과 `README.md`도 함께 고칩니다.

## 파일 구조

| 파일 | 역할 |
| --- | --- |
| `index.client.tsx` | 패널(`board`)과 ⌘K 명령 등록 |
| `index.server.ts` | 호스트 설정 등록, 요약 RPC 처리, 종료 시 정리 |
| `client/AgentBoard.tsx` | 보드 화면 전체: 카드, 화살표, 지시 말풍선, 워크스페이스 상자, 헤더, 드래그, 확대와 이동 |
| `client/look.ts` | 태그 색(모델, 노력, 권한), `tint()`, 밝은 테마에서 카드에 쓰는 `GHOSTTY` 색과 `nodeColors()` |
| `client/messages.ts` | 화면 문구 전체. en, ko, zh-CN 리소스와 ⌘K 검색어 `keywords`가 있고, `Strings<typeof en>` 타입이 세 언어의 키를 컴파일할 때 맞춥니다 |
| `client/web.ts` | DOM이 필요한 코드(휠 확대와 이동, ⌘Z)만 두는 곳. 모든 export는 `Platform.OS === "web"`일 때만 동작 |
| `shared/board.ts` | 순수 로직: 트리 배치, 워크스페이스 상자, 화살표 경로, Shift 정렬, 카드의 도구 동사(`ActivityWords`), 타임라인 요약 입력 |
| `shared/board.test.mjs` | `shared/` 테스트 (`npm test`) |
| `shared/layout.ts` | 호스트 설정: 카드 위치 `positions`, Haiku 요약 켜기 `summaries` |
| `shared/summary.ts`, `server/summary.ts` | Haiku 요약 RPC(카드 제목과 「지금」, 지시 요약). 앱 언어 `locale`을 입력으로 받고, 데몬에서 `claude -p --model haiku` 실행, 캐시, 동시 2개 |
| `shared/labels.ts`, `server/labels.ts` | 워크스페이스 레이블 색 RPC. 플러그인 SDK에 레이블 목록이 없어서 데몬의 `projects/workspace-labels.json`을 읽음 |
| `shared/icons.ts` | provider 아이콘 SVG (simple-icons, CC0) |
| `assets/` | 레지스트리 목록 이미지 `board-dark.webp`(썸네일), `instructions.webp`, `board-light.webp`. `paseo-plugin.json`의 `media`가 이 파일들을 가리킵니다 |
| `README.md` | GitHub와 npm에 보이는 소개, 설치와 개발 명령 |
| `OVERVIEW.md`, `OVERVIEW.zh-CN.md` | 레지스트리 목록 페이지(영어, 중국어 간체). 설치 명령은 넣지 않습니다 |

탭마다 다른 보기 설정(종료된 에이전트, 강조, 숨긴 그래프, 워크스페이스별 묶기)은 `client/AgentBoard.tsx`의 `viewSchema`에 있고 `useTabState`로 저장됩니다.

## 작업 순서

1. 코드를 고칩니다.
2. `npm run typecheck`와 `npm test`를 실행해 둘 다 통과하는지 확인합니다.
3. `paseo plugin reload paseo-agent-dashboard`로 다시 불러옵니다.
4. `paseo plugin ls`에서 `running`인지, `paseo plugin logs paseo-agent-dashboard`에 오류가 없는지 확인합니다.
5. 사용자에게 보드 탭을 닫았다가 다시 열어 확인해 달라고 알립니다.

데몬은 재시작하지 않습니다. 재시작하면 작업 중인 에이전트가 함께 꺼질 수 있습니다.

## 배포 순서

1. `package.json`의 `version`을 올립니다.
2. `npm run typecheck`와 `npm test`를 실행해 둘 다 통과하는지 확인합니다.
3. `npm publish`로 npm에 올립니다. scope가 붙은 패키지라서 처음 올릴 때만 `--access public`을 붙입니다.
4. npm에 새 버전이 올라오면 Paseo 플러그인 레지스트리(getpaseo/plugins)가 버전을 올리는 PR을 자동으로 열기 때문에, 레지스트리에 다시 제출하지 않아도 됩니다.

## 지켜야 할 규칙

- 화면은 React Native 기본 요소(`View`, `Text`, `Pressable`, `ScrollView`)로만 만듭니다. HTML 요소, `className`, `onClick`은 쓰지 않습니다.
- DOM API(`window`, 이벤트 리스너 등)는 `client/web.ts` 밖에서 쓰지 않습니다.
- `node:` 모듈은 `server/`에서만 import합니다. `shared/`에는 React와 Node 없이 동작하는 순수 로직만 둡니다.
- 글자색은 `theme.colors`에서 가져옵니다. 태그처럼 어느 테마에서나 같은 색이 필요하면 `client/look.ts`의 색을 씁니다.
- 카드, 화살표 버튼, 지시 말풍선은 `nodeColors(theme.colors)`의 색을 씁니다. 밝은 테마(`surface0`의 Rec.601 밝기가 128 초과)에서는 세 요소가 Ghostty 어두운 색을 유지하고, 배경, 헤더, 토글, 화살표 선, 워크스페이스 상자는 테마 색을 따릅니다.
- `shared/`에 로직을 추가하거나 바꾸면 `shared/board.test.mjs`에 테스트를 추가합니다.
- 화면에 보이는 문구는 모두 `client/messages.ts`를 거치며, en, ko, zh-CN 세 언어를 함께 고칩니다. 컴포넌트에는 문자열을 직접 쓰지 않고 `useTranslation(messages)`의 `t()`로 가져옵니다.
- `OVERVIEW.md`와 `OVERVIEW.zh-CN.md`를 함께 고칩니다. 화면 요소 이름은 `client/messages.ts`의 en, zh-CN 문자열과 똑같이 쓰고, 레지스트리 검사기가 거부하는 `paseo plugin add`, `npm install`, `npm i`는 두 파일 어디에도 쓰지 않습니다.

## 알아 둘 동작

- 쌓는 순서(`zIndex`): 카드 1, 끌고 있는 카드 10, 지시 아이콘 20, 지시 말풍선 30. 워크스페이스 상자와 화살표 선은 0입니다. React Native Web은 모든 View에 `zIndex: 0`을 주기 때문에, 그리는 순서보다 `zIndex`가 우선합니다.
- 지시 말풍선은 웹에서 캔버스 밖, 뷰포트 위에 그립니다. 위치는 `캔버스 좌표 × 배율 − 카메라 위치`로 바꿔 계산하고, 네이티브에서는 캔버스 안에 그립니다.
- 웹에서는 ScrollView 대신 카메라(이동 거리와 배율) 방식입니다. 휠과 트랙패드 입력은 `listenForWheel`이 받습니다. 드래그 거리는 배율로 나눠서 씁니다.
- Shift 드래그 여부는 React Native Web 응답자 이벤트의 `nativeEvent.shiftKey`로 알 수 있습니다.
- Paseo 에이전트 제목은 첫 프롬프트 앞부분을 잘라 저장한 값이라서, 카드 제목과 「지금」은 Haiku 요약으로 만듭니다. 요약 프롬프트와 길이 제한은 `server/summary.ts`에 있습니다.
- 컴팩트 중인지는 타임라인의 `compaction` 항목으로 판단합니다. Claude는 시작할 때 `loading`, 끝날 때 `completed` 항목을 따로 남기기 때문에, 마지막 지시 이후 가장 최근 `compaction` 항목이 `loading`이면 컴팩트 중으로 봅니다.
- 에이전트 정보에는 프로필 id가 없어서, `profileOf()`가 provider, 모델, 권한, 노력이 모두 같은 프로필을 찾습니다. 프로필 목록은 `paseo.config.get()`의 `agentProfiles`이고, 아이콘은 Lucide 이름(camelCase), 색은 Paseo identity 색 이름이며 `client/look.ts`의 `identityColor()`로 바꿉니다.
- 다른 에이전트가 보낸 지시는 `user_message`가 아니라 `name: "agent_message"`인 `tool_call`로 기록되며, `agentMessage.event === "message"`이고 `agentMessage.sender.id`가 보낸 에이전트입니다. 지시를 읽을 때는 `shared/board.ts`의 `promptOf()`를 씁니다.
- 강조는 `lineage()`(조상과 후손), 숨기기는 `subtrees()`(후손)로 계산합니다. 탭 상태의 `focus`와 `hidden`에는 에이전트 id가 들어갑니다.
- 부모와 자식은 `paseo.parent-agent-id` 라벨로 찾습니다. 에이전트 정보에는 부모 필드가 없습니다.
- Haiku 요약은 앱 언어로 씁니다. 클라이언트가 `useTranslation(messages).locale`을 보내면 서버가 태그를 정규화하고 `Intl.DisplayNames`로 영어 언어 이름을 만들어 프롬프트에 넣으며, 한국어, 일본어, 중국어는 글자 수 제한을 절반으로 줄입니다. 서버 캐시 키와 클라이언트 쿼리 키에는 locale이 들어갑니다.
- Haiku에 보내는 `transcript()`는 화면 언어가 무엇이든 영어 라벨(`User:`, `Instruction:`, `Agent:`, `Tool:`)과 `ENGLISH_WORDS`를 씁니다. 카드에 보이는 도구 동사는 `describeActivity(items, words)`에 넘긴 번역 단어로 만듭니다.
