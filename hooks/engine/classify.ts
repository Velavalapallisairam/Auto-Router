// Local task classification: reads a prompt and says how hard, how risky and
// how wide the task is. Pure and deterministic: no model call, no `$`, no I/O.
//
// Prompt length alone decides nothing. A short prompt with risk words is not
// simple, and a long prompt whose only intent is a lookup is not complex.
// With no clear signal the answer is `standard` at low confidence, which the
// router sends to Sonnet or stronger, never to the cheapest tier.

import type {
  AgentKey,
  Alias,
  Ambiguity,
  Classification,
  Complexity,
  Effort,
  Risk,
  Scope,
} from '../../types'

const MAX_CHARS = 8000

type Pat = readonly [RegExp, string]
type Weighted = readonly [RegExp, string, number]

// ------------------------------------------------------------- intents

const TRIVIAL_EDIT: readonly Pat[] = [
  [/\b(?:fix|correct|check|clean up)\b[^.\n]{0,40}\b(?:typos?|grammar|spelling|punctuation|wording|capitali[sz]ation)\b/, 'copy edit'],
  [/\b(?:proofread|rephrase|reword|paraphrase)\b/, 'copy edit'],
  [/\brename\b[^.\n]{1,80}\bto\b/, 'rename'],
  [/\b(?:reformat|re-?indent|prettify|pretty-?print|lint fix|format (?:this|the|my) (?:file|code|json|document))\b/, 'format'],
  [/\b(?:bump|update) (?:the )?version\b/, 'version bump'],
  [/\badd (?:a |an |some )?(?:comments?|docstrings?|log line|print statement|todo)\b/, 'annotation'],
  [/\b(?:sort|organi[sz]e) (?:the )?imports\b/, 'sort imports'],
  [/\b(?:commit message|changelog entry|pr title|pr description|release note)\b/, 'short writing'],
  [/\b(?:convert|change)\b[^.\n]{1,40}\b(?:to|into)\b[^.\n]{0,20}\b(?:json|yaml|csv|toml|xml|markdown|camelcase|snake_case|uppercase|lowercase|celsius|fahrenheit|utc|iso)\b/, 'format conversion'],
]

const TRIVIAL_READ: readonly Pat[] = [
  [/\b(?:summari[sz]e|summary of|tl;?dr|recap|give me (?:a|an) (?:quick |short |brief )?(?:overview|gist|summary))\b/, 'summary'],
  [/\b(?:list|show|print|display|count|enumerate)\b[^.\n]{0,50}\b(?:files?|folders?|directories|lines?|functions?|classes|imports?|todos?|branches|commits?|dependencies|endpoints?|routes?|tests?)\b/, 'listing'],
  [/\b(?:find|search for|grep|locate|look up|where (?:is|are|do|does))\b/, 'search'],
  [/\btranslate\b/, 'translate'],
  [/^(?:hi|hello|hey|thanks|thank you|good (?:morning|evening))\b/, 'greeting'],
  [/\bwhat (?:is|are|does|do|was|were)\b|\bwho (?:is|was)\b|\bdefine\b|\bmeaning of\b|\bwhat'?s (?:the|a|an)\b/, 'factual question'],
  [/\b(?:explain|describe|walk me through|how does|how do)\b/, 'explanation'],
]

const STANDARD_VERB =
  /\b(?:implement|build|create|develop|write|add|make|generate|set ?up|scaffold|fix|resolve|patch|update|modify|change|edit|extend|install|configure|upgrade|remove|delete|replace|move|extract|port|convert|wire up|hook up)\b/
const STANDARD_OBJECT =
  /\b(?:feature|endpoint|component|function|method|class|tests?|bug|issue|error|module|api|service|script|page|form|route|handler|hook|query|logic|validation|integration|pipeline|workflow|schema|model|table|cli|command|plugin|extension|app|application|ui|button|view|screen|layout|styles?|database|config|dockerfile|parser|server|client|library|package|job|cron|task|worker|migration|report|dashboard|chart)\b/
const BUILD = /\b(?:implement|build|develop|engineer|code up|program)\b/

const COMPLEX: readonly Weighted[] = [
  [/\b(?:architect(?:ure|ural)?|system design|design doc|technical design|high[- ]level design)\b/, 'architecture', 2],
  [/\bdesign (?:a|an|the|our|my)\b[^.\n]{0,60}\b(?:system|architecture|schema|api|protocol|pipeline|framework|platform|service|data model|workflow|strategy)\b/, 'design', 2],
  [/\brefactor\b[^.\n]{0,60}\b(?:entire|whole|across|all|modules?|codebase|architecture|layer|system)\b/, 'large refactor', 2],
  [/\brefactor(?:ing)?\b/, 'refactor', 1],
  [/\b(?:race condition|deadlock|memory leak|heisenbug|intermittent(?:ly)?|flaky|non-?deterministic|segfault|data corruption|corrupt(?:ed|ion)|concurrency bug|out of memory|oom)\b/, 'hard bug', 2],
  [/\b(?:root[- ]cause|investigate (?:why|the|this)|figure out why|diagnos(?:e|is)|post-?mortem)\b/, 'investigation', 1],
  [/\b(?:debug|troubleshoot)(?:ging)?\b/, 'debugging', 1],
  [/\bmigrat(?:e|ion|ing)\b[^.\n]{0,60}\b(?:to|from|onto)\b/, 'migration', 2],
  [/\b(?:optimi[sz]e|optimi[sz]ation|performance|profil(?:e|ing)|bottleneck|latency|throughput|scalab(?:le|ility)|speed up)\b/, 'performance', 1],
  [/\b(?:concurren(?:t|cy)|multi-?thread(?:ed|ing)?|paralleli[sz]e|distributed|consensus|replication|sharding|event[- ]sourcing|cqrs|lock-?free|idempoten(?:t|cy))\b/, 'concurrency/distributed', 2],
  [/\b(?:algorithm|data structure|dynamic programming|graph (?:search|traversal)|parser|compiler|interpreter|type system|state machine|scheduler|query planner)\b/, 'algorithmic', 1],
  [/\b(?:end[- ]to[- ]end|from scratch|full[- ]stack|whole (?:app|application|system|pipeline|product))\b/, 'end-to-end build', 2],
  [/\bintegrat(?:e|ion|ing)\b/, 'integration', 1],
  [/\b(?:trade-?offs?|pros and cons|compare\b[^.\n]{0,40}\b(?:approach|approaches|options?|architectures?|frameworks?|librar(?:y|ies)|designs?)|evaluate (?:options|approaches|alternatives))\b/, 'trade-off analysis', 1],
  [/\b(?:deep dive|thorough(?:ly)?|comprehensive(?:ly)?|in[- ]depth|exhaustive(?:ly)?|rigorous(?:ly)?)\b/, 'depth requested', 1],
  [/\b(?:research|literature review|survey of|state of the art|investigate options)\b/, 'research', 1],
  [/\b(?:multi-?step|step[- ]by[- ]step plan|plan and (?:implement|execute|build)|roadmap|strategy for)\b/, 'multi-step plan', 1],
  [/\b(?:rewrite|re-?architect|overhaul|redesign|re-?engineer|moderni[sz]e)\b/, 'rewrite', 2],
  [/\b(?:reverse[- ]engineer|decompile|protocol analysis)\b/, 'reverse engineering', 1],
  [/\b(?:autonomous|orchestrat(?:e|ion|or)|multi-?agent|workflow engine|routing engine|plugin system)\b/, 'orchestration', 1],
  [/\b(?:audit|security review|code review|threat model\w*|pen(?:etration)?[- ]?test\w*|vulnerability (?:scan|assessment))\b/, 'audit or review', 2],
]

// A lookup that is really a diagnosis: "what is wrong with this", "why does it fail".
const TROUBLE = /\b(?:why|wrong|bugs?|issues?|problems?|errors?|fail\w*|broken|crash\w*|not working|doesn'?t work)\b/

const EXCEPTIONAL: readonly Pat[] = [
  [/\b(?:formal(?:ly)? (?:verif\w+|proof|prove|specif\w+)|prove (?:that|the|its|correctness)|theorem|lemma|proof of (?:correctness|termination))\b/, 'formal reasoning'],
  [/\b(?:novel|research[- ]level|breakthrough|unsolved|open problem|first principles)\b/, 'novel reasoning'],
  [/\bdesign (?:a |an |the )?(?:new )?(?:consensus|byzantine|cryptographic|lock-?free|wait-?free|distributed (?:database|transaction|consensus))\b/, 'hard systems design'],
  [/\b(?:operating system kernel|database engine|compiler backend|garbage collector|type checker|query optimi[sz]er|virtual machine|hypervisor)\b/, 'systems core'],
  [/\bthreat model\b[^.\n]{0,60}\b(?:entire|whole|complete|full|organi[sz]ation|platform|company)\b/, 'org-wide threat model'],
  [/\bzero[- ]downtime\b[^.\n]{0,80}\bmigrat/, 'zero-downtime migration'],
]

// ---------------------------------------------------------------- risk

const RISK_CRITICAL: readonly Pat[] = [
  [/\brm\s+-(?:rf|fr|r)\b|\bdel\s+\/s\b|\brmdir\s+\/s\b|\bformat (?:the )?(?:disk|drive)\b/, 'destructive command'],
  [/\bdrop\s+(?:the\s+|a\s+|all\s+|our\s+)?(?:[\w-]+\s+)?(?:tables?|databases?|schemas?|index(?:es)?|collections?)\b|\btruncate\s+(?:the\s+)?(?:[\w-]+\s+)?table\b/, 'destructive SQL'],
  [/\b(?:delete|remove|wipe|purge|erase|destroy|clear)\b[^.\n]{0,30}\b(?:all|every|entire|whole|production|prod|database|db|bucket|volume|backups?|users?|accounts?|records|customer data)\b/, 'mass deletion'],
  [/\bforce[- ]?push\b|\bpush\s+(?:-f|--force)\b|\breset\s+--hard\b/, 'history rewrite'],
  [/\b(?:production|prod)\b[^.\n]{0,40}\b(?:database|db|data|deploy\w*|release|rollout|migration|outage|incident|hotfix|server|cluster|secrets?)\b/, 'production change'],
  [/\b(?:deploy\w*|release|ship|push|roll ?out|migrat\w*|hotfix|apply)\b[^.\n]{0,40}\b(?:to |in |on |into )?(?:production|prod)\b/, 'production change'],
  [/\b(?:irreversible|cannot be undone|can'?t be undone|data loss|destructive)\b/, 'irreversible'],
  [/\b(?:live (?:trading|orders?|money|funds)|real money|wire transfer|payouts?|withdraw(?:al)?s?)\b/, 'real money'],
]

const RISK_HIGH: readonly Pat[] = [
  [/\bsecurity\b|\bvulnerab\w+|\bexploit\w*|\bcve-?\d|\bpen(?:etration)?[- ]?test\w*|\bthreat model\w*|\battack surface|\bhardening\b|\bmalware\b/, 'security'],
  [/\bauth(?:entication|orization|n|z)?\b|\boauth2?\b|\bsso\b|\bsaml\b|\bjwt\b|\bsession (?:token|cookie|fixation|hijack\w*)|\blogin (?:flow|system|endpoint)|\bpasswords?\b|\b2fa\b|\bmfa\b/, 'authentication'],
  [/\b(?:encrypt\w*|decrypt\w*|cryptograph\w*|cipher|tls|ssl certificate|signing key|private key|key rotation|kms|hmac)\b/, 'cryptography'],
  [/\b(?:api|access|auth|bearer|refresh|secret|service|deploy) (?:keys?|tokens?)\b|\bcredentials?\b|\bsecrets? (?:manager|store|rotation|file|key)\b/, 'credentials'],
  [/\b(?:permissions?|privileges?|rbac|acl|iam|role[- ]based|access control|sandbox escape|injection|xss|csrf|ssrf|sqli|deseriali[sz]ation)\b/, 'access control'],
  [/\b(?:pii|gdpr|hipaa|pci|sox|compliance|personal data|customer data|sensitive data|data protection)\b/, 'regulated data'],
  [/\b(?:payments?|billing|invoices?|refunds?|chargebacks?|stripe|checkout|ledger|accounting|payroll|tax(?:es)?)\b/, 'money'],
  [/\b(?:production|prod)\b/, 'production'],
  [/\b(?:database|schema|data) migrations?\b|\balter table\b|\bbackfill\b/, 'database migration'],
  [/\b(?:terraform|kubernetes|k8s|helm|cloudformation|pulumi)\b[^.\n]{0,40}\b(?:apply|change|delete|destroy|update|deploy)\b/, 'infrastructure change'],
  [/\b(?:medical|clinical|legal advice|financial advice|safety[- ]critical|aviation|automotive)\b/, 'high-stakes domain'],
]

const RISK_MEDIUM: readonly Pat[] = [
  [/\b(?:deploy\w*|release|rollout|publish|ship (?:it|this|to))\b/, 'deployment'],
  [/\b(?:database|db|sql|schema|migrations?)\b/, 'database'],
  [/\b(?:ci\/cd|ci pipeline|github actions|workflow file|build pipeline)\b/, 'CI'],
  [/\b(?:infrastructure|terraform|kubernetes|k8s|docker|helm|aws|gcp|azure|cloudflare|nginx|dns|firewall|load balancer)\b/, 'infrastructure'],
  [/\b(?:dependency|dependencies) (?:upgrade|update)|\bmajor version\b|\bbreaking change\b|\bpublic api\b|\bbackwards?[- ]compat\w*/, 'compatibility'],
  [/\b(?:delete|remove|drop)\b[^.\n]{0,30}\b(?:files?|folders?|directories|branch(?:es)?|tables?|columns?)\b/, 'deletion'],
]

// ----------------------------------------------------------- ambiguity

const VAGUE_HIGH: readonly Pat[] = [
  [/^(?:please |can you |could you |just )?(?:fix|improve|clean ?up|handle|sort out|finish|do|redo|update|change) (?:it|this|that|things|everything|the thing|the code|the stuff)(?: (?:up|properly|please|now))?[.!?]*$/, 'no specifics'],
  [/\b(?:make|get) (?:it|this|that|things|everything) (?:work|better|good|nice|nicer|faster|right|pretty|clean)\b/, 'vague goal'],
  [/\b(?:doesn'?t|does not|isn'?t|is not|won'?t|not) work(?:ing)?\b|\bit'?s broken\b|\bsomething(?:'s| is) wrong\b|\bkeeps? (?:failing|crashing|breaking)\b/, 'symptom only'],
  [/\b(?:not sure|i don'?t know|no idea|whatever (?:you think|works)|figure (?:it )?out|you decide|up to you)\b/, 'open-ended'],
]

const VAGUE_MEDIUM: readonly Pat[] = [
  [/\b(?:how (?:should|would|do|can) (?:i|we)|what(?:'s| is|s) the best (?:way|approach|option)|which (?:approach|option|one)|should (?:i|we)|is it (?:better|worth)|best practice)\b/, 'approach question'],
  [/\b(?:something like|kind of|sort of|somehow|maybe|perhaps|and so on|or whatever)\b/, 'loose wording'],
]

// ---------------------------------------------------------------- scope

const SCOPE_BROAD =
  /\b(?:entire|whole|all (?:the |of the |our |my )?(?:files|services|modules|repos|packages|components|endpoints|tests|pages|projects)|across (?:the |our |all )?(?:codebase|repo|repository|monorepo|project|services|system|stack)|every (?:file|service|module|endpoint|component|page|test)|codebase[- ]wide|system[- ]wide|org(?:ani[sz]ation)?[- ]wide|globally|everywhere|multi-?repo)\b/
const SCOPE_MULTI =
  /\b(?:multiple|several|a few|both|many|various|each of|and then|after that|as well as|in addition)\b/

// -------------------------------------------------------------- domains

const DOMAIN_PATTERNS: readonly Pat[] = [
  [/\b(?:architect\w*|system design|design doc|technical design|scalab\w+|microservices?|monolith|module boundar\w+|domain model|data model|service mesh|event[- ]driven)\b/, 'architecture'],
  [/\b(?:security|secure|vulnerab\w+|exploit\w*|oauth2?|jwt|encrypt\w*|cryptograph\w*|credentials?|permissions?|rbac|iam|xss|csrf|ssrf|injection|threat model\w*|hardening|sandbox)\b|\bauth(?:entication|orization|n|z)?\b|\bpen(?:etration)?[- ]?test\w*/, 'security'],
  [/\b(?:react|vue|svelte|angular|next\.?js|nuxt|css|scss|tailwind|html|component|ui|ux|layout|responsive|frontend|front-end|browser|dom|animation|accessib\w+|a11y)\b/, 'frontend'],
  [/\b(?:api|endpoint|server|backend|back-end|rest|graphql|grpc|queue|worker|webhook|middleware|microservice|service)\b/, 'backend'],
  [/\b(?:sql|postgres\w*|mysql|sqlite|mongo\w*|redis|schema|query|queries|index(?:es)?|migrations?|orm|prisma|database|db)\b/, 'database'],
  [/\b(?:docker|kubernetes|k8s|terraform|ci\/cd|pipeline|deploy\w*|aws|gcp|azure|cloudflare|nginx|helm|infrastructure|devops|serverless|lambda)\b/, 'infra'],
  [/\b(?:debug\w*|bug|crash\w*|exception|stack trace|traceback|fail(?:s|ing|ed|ure)|broken|regression|troubleshoot\w*)\b/, 'debugging'],
  [/\b(?:tests?|testing|unit test|integration test|e2e|coverage|jest|pytest|vitest|playwright|cypress|mock\w*|fixture)\b/, 'testing'],
  [/\b(?:readme|docs?|documentation|docstrings?|changelog|jsdoc|typedoc|guide|tutorial)\b/, 'docs'],
  [/\b(?:research|investigate|compare|evaluate|survey|benchmark|literature|sources|find out|look into)\b/, 'research'],
  [/\b(?:dataset|dataframe|pandas|numpy|etl|analytics|machine learning|ml model|training|csv|parquet|statistics)\b/, 'data'],
  [/\b(?:rename|reformat|re-?indent|lint|sort imports|bump|replace all|find and replace|search and replace|typos?|grammar|spelling)\b/, 'mechanical'],
  [/\b(?:find|search|grep|locate|where is|where are|list|look up)\b/, 'search'],
  [/\b(?:summar\w+|tl;?dr|recap|overview|gist)\b/, 'summary'],
]

// ------------------------------------------------------ explicit asks

const EXPLICIT_MODEL =
  /\b(?:use|using|with|on|via|switch(?:ing)? to|run (?:this |it )?(?:on|with)|route (?:this |it )?to)\s+(?:claude[- ])?(fable|opus|sonnet|haiku)\b/
const EXPLICIT_MODEL_TAIL = /\b(fable|opus|sonnet|haiku)\s+(?:model\s+)?(?:for this|only)\b/
const NEGATED_MODEL = /\b(?:don'?t|do not|never|avoid|without)\s+(?:use |using )?(?:claude[- ])?(fable|opus|sonnet|haiku)\b/
const EXPLICIT_EFFORT =
  /\b(low|medium|high|xhigh|x-high|extra[- ]high|max(?:imum)?)\s+(?:reasoning\s+)?effort\b|\beffort\s*(?:level)?\s*[:=]?\s*(?:to |at )?(low|medium|high|xhigh|max)\b/
const NO_AGENTS = /\b(?:no|without|don'?t use|do not use|avoid)\s+(?:sub-?agents?|agents|delegat\w+)\b/
const WANT_AGENTS =
  /\b(?:use|spawn|launch|dispatch|delegate to|run)\s+(?:a |an |the |two |2 |multiple |parallel |some )?(?:sub-?agents?|agents)\b|\bin parallel\b/

// Every word of the prompt is an assent, a nudge or a courtesy: "ok go ahead", "looks good, thanks".
const CONTINUATION =
  /^(?:(?:go ahead|go on|do it|do that|carry on|keep going|sounds good|looks good|try again|thank you|ok(?:ay)?|k|yes|yep|yeah|yup|sure|go|continue|proceed|next|lgtm|perfect|great|nice|thanks|thx|ty|cool|right|correct|exactly|no|nope|nah|stop|wait|retry|again|same|please|then|now)\b[\s,.!]*)+$/
const FOLLOW_UP = /^(?:and|also|then|now|plus|additionally|next,?)\b/

// The person says the last answer missed, or asks for the same thing again.
// Read only in a short prompt: a long one that mentions an old failure is a task of its own.
const MISS: readonly RegExp[] = [
  /^(?:please )?(?:retry|again|redo)\b/,
  /\b(?:try|do (?:it|that|this)|run (?:it|that|this)) (?:once )?again\b|\bredo (?:it|this|that)\b/,
  /\bstill (?:broken|wrong|failing|fails|crash\w*|not (?:working|fixed|right|correct)|doesn'?t work|(?:the )?same (?:error|issue|problem|bug)|(?:getting|seeing|throws?|shows?) (?:the|that|an) (?:same )?(?:error|issue|problem|bug))\b/,
  /\b(?:that|this|it)(?:'s| is| was)? (?:wrong|incorrect|not right|not correct|not what i (?:asked|wanted|meant|said))\b/,
  /\b(?:that|this|it) (?:didn'?t|did not|doesn'?t|does not) (?:work|fix (?:it|anything)|help)\b/,
  /\bnot what i (?:asked|wanted|meant|said)\b|\byou (?:broke|missed|ignored|forgot|misunderstood)\b|\bsame (?:error|issue|problem|bug) (?:again|as before)\b/,
]

const TRACE =
  /Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)|Exception in thread|panic: |Unhandled(?:Promise)?Rejection|error TS\d+|^\s*File ".+", line \d+/m
const FILE_PATH =
  /(?:[\w.-]+[\\/])+[\w.-]+\.\w{1,6}\b|\b[\w-]+\.(?:tsx?|jsx?|mjs|py|go|rs|java|rb|php|cs|cpp|c|h|json|ya?ml|toml|md|sql|sh|ps1|s?css|html|vue|svelte)\b/g
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/gm
const REQUIREMENT = /\b(?:must|should|shall|needs? to|required?|ensure|make sure)\b/g

const COMPLEXITY_ORDER: readonly Complexity[] = [
  'simple',
  'standard',
  'complex',
  'critical',
  'exceptional',
]
const RISK_ORDER: readonly Risk[] = ['low', 'medium', 'high', 'critical']

function labels(text: string, pats: readonly Pat[]): string[] {
  const found: string[] = []
  for (const [re, label] of pats) {
    if (re.test(text) && !found.includes(label)) found.push(label)
  }
  return found
}

function strip(text: string, pats: readonly Pat[]): string {
  let rest = text
  for (const [re] of pats) rest = rest.replace(re, ' ')
  return rest
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

function raise(level: Complexity, to: Complexity): Complexity {
  return COMPLEXITY_ORDER.indexOf(to) > COMPLEXITY_ORDER.indexOf(level) ? to : level
}

function effortWord(word: string | undefined): Effort | undefined {
  if (word === undefined) return undefined
  const w = word.toLowerCase()
  if (w === 'low' || w === 'medium' || w === 'high' || w === 'xhigh' || w === 'max') return w
  if (w === 'x-high' || w.startsWith('extra')) return 'xhigh'
  if (w === 'maximum') return 'max'
  return undefined
}

/** Classifies one prompt. `text` is the prompt as typed; nothing else is read. */
export function classify(text: string): Classification {
  const raw = typeof text === 'string' ? text.slice(0, 60000) : ''
  const hasCode = /```/.test(raw)
  const hasTrace = TRACE.test(raw)
  const instruction = raw.replace(/```[\s\S]*?(?:```|$)/g, ' ').slice(0, MAX_CHARS)
  const lower = instruction.toLowerCase().replace(/[‘’]/g, "'").trim()
  const wordCount = lower.split(/\s+/).filter(w => w.length > 0).length
  const signals: string[] = []

  // ---- explicit asks
  const explicit: Classification['explicit'] = {}
  const negated = NEGATED_MODEL.exec(lower)
  const named = EXPLICIT_MODEL.exec(lower) ?? EXPLICIT_MODEL_TAIL.exec(lower)
  if (named?.[1] !== undefined && (negated === null || negated[1] !== named[1])) {
    explicit.model = named[1] as Alias
    signals.push(`explicit model: ${named[1]}`)
  }
  const effortAsk = EXPLICIT_EFFORT.exec(lower)
  const asked = effortWord(effortAsk?.[1] ?? effortAsk?.[2])
  if (asked !== undefined) {
    explicit.effort = asked
    signals.push(`explicit effort: ${asked}`)
  }
  if (/\bultrathink\b/.test(lower)) {
    explicit.ultrathink = true
    signals.push('ultrathink')
  }
  if (NO_AGENTS.test(lower)) explicit.noSubagents = true
  else if (WANT_AGENTS.test(lower)) explicit.wantAgents = true

  // ---- structure
  const listItems = count(instruction, LIST_ITEM)
  const filePaths = new Set(instruction.match(FILE_PATH) ?? []).size
  const requirements = count(lower, REQUIREMENT)
  const isQuestion = /\?\s*$/.test(lower) || /^(?:what|who|when|where|which|why|how|is|are|can|could|does|do|should|would|will)\b/.test(lower)

  // ---- intents
  const trivialEdit = labels(lower, TRIVIAL_EDIT)
  const trivialRead = labels(lower, TRIVIAL_READ)
  const trivial = [...trivialEdit, ...trivialRead]
  const rest = strip(strip(lower, TRIVIAL_EDIT), TRIVIAL_READ)
  const build = BUILD.test(rest)
  const standardStrong = build || (STANDARD_VERB.test(rest) && STANDARD_OBJECT.test(rest))
  const anyVerb = STANDARD_VERB.test(lower)

  let complexScore = 0
  const complexLabels: string[] = []
  for (const [re, label, weight] of COMPLEX) {
    if (re.test(lower)) {
      complexScore += weight
      if (!complexLabels.includes(label)) complexLabels.push(label)
    }
  }
  const exceptional = labels(lower, EXCEPTIONAL)

  // ---- risk
  const critical = labels(lower, RISK_CRITICAL)
  const high = labels(lower, RISK_HIGH)
  const medium = labels(lower, RISK_MEDIUM)
  const risk: Risk =
    critical.length > 0 ? 'critical' : high.length > 0 ? 'high' : medium.length > 0 ? 'medium' : 'low'
  const riskRank = RISK_ORDER.indexOf(risk)
  for (const label of [...critical, ...high].slice(0, 4)) signals.push(`risk: ${label}`)
  if (risk === 'medium') signals.push(`risk: ${medium[0] ?? 'medium'}`)

  // ---- scope
  let scope: Scope = 'local'
  if (SCOPE_BROAD.test(lower)) scope = 'broad'
  else if (SCOPE_MULTI.test(lower) || listItems >= 3 || filePaths >= 3) scope = 'multi'
  if (scope !== 'local') signals.push(`scope: ${scope}`)

  // ---- ambiguity
  const vagueHigh = labels(lower, VAGUE_HIGH)
  const vagueMedium = labels(lower, VAGUE_MEDIUM)
  const hasSpecifics = hasCode || hasTrace || filePaths >= 1
  let ambiguity: Ambiguity = 'low'
  if (vagueHigh.length > 0 && !hasSpecifics && wordCount <= 40) ambiguity = 'high'
  else if (vagueHigh.length > 0 || vagueMedium.length > 0) ambiguity = 'medium'
  if (ambiguity !== 'low') signals.push(`ambiguity: ${vagueHigh[0] ?? vagueMedium[0] ?? ambiguity}`)

  // ---- domains
  const domains = labels(lower, DOMAIN_PATTERNS)
  if (hasTrace && !domains.includes('debugging')) domains.push('debugging')

  // ---- continuation
  const continuation =
    wordCount === 0 ||
    (wordCount <= 6 && CONTINUATION.test(lower)) ||
    (wordCount <= 12 && FOLLOW_UP.test(lower) && complexScore === 0 && riskRank < 2 && !standardStrong)
  if (continuation) signals.push('continuation')
  const miss = wordCount > 0 && wordCount <= 40 && MISS.some(re => re.test(lower))
  if (miss) signals.push('miss: the last answer is called wrong')

  // ---- complexity
  let level: Complexity
  let isMatched = true
  const isHeadDomain = domains.includes('architecture') || domains.includes('security')
  const isApproach = vagueMedium.includes('approach question')
  const isTroubled = hasTrace || TROUBLE.test(lower)
  // Asking to be told or shown something, with nothing to build or change.
  const readOnly = trivialRead.length > 0 && trivialEdit.length === 0 && !standardStrong
  if (exceptional.length > 0 && (complexScore >= 2 || riskRank >= 2 || scope === 'broad')) {
    level = 'exceptional'
    signals.push(`exceptional: ${exceptional[0] ?? ''}`)
  } else if (complexScore >= 2) {
    level = 'complex'
  } else if (trivialEdit.length > 0 && !standardStrong && complexScore === 0) {
    // A mechanical edit is simple unless it reaches across the codebase.
    level = scope === 'broad' ? 'standard' : 'simple'
  } else if (trivialRead.length > 0 && !standardStrong && complexScore === 0 && !isApproach && !isTroubled) {
    // A plain lookup. A question about what to do, or about what is wrong, is not one.
    level = 'simple'
  } else if (standardStrong || complexScore === 1 || anyVerb || isApproach || trivialRead.length > 0) {
    level = 'standard'
  } else {
    // Nothing recognisable: not assumed simple, however short.
    level = 'standard'
    isMatched = false
  }
  for (const label of complexLabels.slice(0, 4)) signals.push(`complex: ${label}`)
  if (level === 'simple') signals.push(`intent: ${trivial[0] ?? 'lookup'}`)

  if (level === 'standard' && scope === 'broad') level = 'complex'
  if (level === 'standard' && (listItems >= 6 || requirements >= 8)) {
    level = 'complex'
    signals.push('many requirements')
  }
  if (risk === 'critical' && level !== 'simple') level = raise(level, 'critical')
  if (risk === 'high' && level === 'complex') level = 'critical'
  if (ambiguity === 'high' && riskRank >= 2) level = raise(level, 'complex')
  if (level === 'critical' && complexScore >= 4 && scope === 'broad' && isHeadDomain) {
    level = 'exceptional'
    signals.push('exceptional: critical, broad, architecture or security')
  }

  // ---- confidence
  let confidence = 0.5
  const isStrongMatch =
    trivial.length > 0 || standardStrong || complexScore >= 2 || exceptional.length > 0
  if (isStrongMatch) confidence += 0.25
  if (wordCount >= 4 && wordCount <= 400) confidence += 0.1
  if (ambiguity === 'high') confidence -= 0.25
  if (ambiguity === 'medium') confidence -= 0.05
  if (!isMatched) confidence -= 0.2
  if (trivial.length > 0 && complexScore >= 2) confidence -= 0.1
  confidence = Math.max(0.05, Math.min(0.95, Math.round(confidence * 100) / 100))

  // ---- verification and delegation
  const levelRank = COMPLEXITY_ORDER.indexOf(level)
  const needsVerification =
    levelRank >= 2 || riskRank >= 2 || /\b(?:tests?|verify|validate|make sure|ensure|confirm)\b/.test(lower)

  const isParallelizable =
    listItems >= 3 ||
    /\b(?:in parallel|independent(?:ly)?|separately|each of)\b/.test(lower) ||
    (scope === 'broad' && (domains.includes('research') || domains.includes('search')))
  const agents: AgentKey[] = []
  let reason = ''
  let suggested = false
  if (explicit.noSubagents === true) {
    reason = 'the user asked for no subagents'
  } else if (explicit.wantAgents === true || (levelRank >= 2 && (isParallelizable || domains.includes('research')) && scope !== 'local')) {
    suggested = true
    if (domains.includes('research') || domains.includes('search')) {
      agents.push(levelRank >= 2 && domains.includes('research') ? 'sousChef' : 'prepCook')
    }
    if (standardStrong || build) agents.push('lineCook')
    if (agents.length === 0) agents.push('lineCook')
    reason = isParallelizable ? 'independent parts can run apart from the main thread' : 'research can run apart from the main thread'
  } else {
    reason = levelRank < 2 ? 'small enough for the main session' : 'shared context is cheaper than a hand-off'
  }

  return {
    complexity: level,
    risk,
    ambiguity,
    scope,
    domains,
    confidence,
    signals,
    explicit,
    continuation,
    miss,
    readOnly,
    needsVerification,
    delegation: {
      suggested,
      agents: agents.slice(0, 2),
      parallel: suggested && isParallelizable ? 2 : 1,
      reason,
    },
    wordCount,
  }
}
