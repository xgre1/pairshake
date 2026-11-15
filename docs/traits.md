# Traits: the data for matching

Every person gets **44 numbers between 0 and 1**, each with a **confidence** between 0 and 1, plus a structured
**persona**. The judge in matching reads the persona; three of the traits set the tone of Emma's introduction (see [architecture.md](architecture.md)); the rest are stored for later use. The code is `edge/src/traits.js`
(the dimensions and how they are read) and `edge/src/room.js` (`enrich`, `traitsOf`).

## Where it comes from

1. The person signs in (LinkedIn or Google) and gives us a write-up of themselves, one of two ways:
   - **Ask ChatGPT / Claude / Gemini**: their own AI answers our prompt (`GPT_PROMPT` in `app/web/index.html`),
     they paste the answer.
   - **No AI? Answer a few questions**: our agent asks the same things (`ONBOARD` in `edge/src/prompts.js`) and
     writes the answer in the same format.

   Both end as the same `PAIRSHAKE PROFILE` text and go through `/quick`.
2. `enrich(u, text)` in `room.js`, in the background:
   - **persona**: one model call turns the text plus the sign-in into structured JSON (`PERSONA` in `prompts.js`).
   - **traits**: three independent model calls rate the 44 dimensions (`readTraits` in `traits.js`). The three
     readings are averaged, weighted by confidence; when they disagree, the confidence goes down.
3. Both are kept on the user, so they are in D1 (`users.data`).

People who got a profile another way (a voice chat, the form) get traits too: `enrich` runs whenever a profile is
written, and `backfillTraits()` fills in anyone who has a profile but no traits each time the room starts.
The ten demo attendees have precomputed traits in `edge/src/seed_traits.json` (rated from their short cards, so
their confidences are lower).

## Reading it

In the room (`room.js`), for anyone, demo attendees included:

```js
const t = this.traitsOf(id);   // null while still being read
t.v.openness          // 0.79   the value
t.c.openness          // 0.69   how sure (0.05 = no evidence, 0.9 = stated)
t.vector              // [44 values in the order below]
t.confidence          // [44 confidences, same order]
t.type                // "ENTJ-A" (16personalities-style, from the Big Five; for show)
t.summary             // 2-3 sentences, written to the person
```

The persona (structured facts: work, skills, goals, looking for, offers, links...) is `this.users[id].persona`.

From the database:

```sql
SELECT id, name,
  json_extract(data, '$.traits.v.openness')       AS openness,
  json_extract(data, '$.traits.c.openness')       AS openness_conf,
  json_extract(data, '$.traits.type')             AS type,
  json_extract(data, '$.persona.goals.looking_for') AS looking_for
FROM users WHERE json_extract(data, '$.traits') IS NOT NULL;
```

## The 44 dimensions

Index is the position in `vector`.

| # | key | group | 0 means | 1 means |
| --- | --- | --- | --- | --- |
| 0 | `openness` | personality | conventional, prefers the familiar | curious, imaginative, drawn to new ideas |
| 1 | `conscientiousness` | personality | spontaneous, flexible, loose with plans | organised, disciplined, follows through |
| 2 | `extraversion` | personality | reserved, recharges alone | outgoing, energised by people |
| 3 | `agreeableness` | personality | challenging, competitive, blunt | cooperative, trusting, accommodating |
| 4 | `emotional_stability` | personality | easily stressed, anxious | calm, steady under pressure |
| 5 | `honesty_humility` | personality | status-seeking, self-promoting | sincere, modest, fair |
| 6 | `assertiveness` | personality | lets others lead the conversation | takes charge, speaks up |
| 7 | `warmth` | personality | formal, keeps distance | friendly, quick to connect |
| 8 | `achievement_drive` | personality | content, relaxed about goals | ambitious, driven to excel |
| 9 | `adventurousness` | personality | prefers routine | seeks novelty and change |
| 10 | `self_direction` | values | not at all | independent thought and action, freedom to choose own goals |
| 11 | `stimulation` | values | not at all | excitement, novelty, challenge |
| 12 | `hedonism` | values | not at all | pleasure, enjoying life |
| 13 | `achievement` | values | not at all | personal success by showing competence |
| 14 | `power` | values | not at all | status, prestige, control over people and resources |
| 15 | `security` | values | not at all | safety, stability, harmony |
| 16 | `conformity` | values | not at all | restraint, following norms and expectations |
| 17 | `tradition` | values | not at all | respect for customs and ideas of one's culture or religion |
| 18 | `benevolence` | values | not at all | caring for the people close to them |
| 19 | `universalism` | values | not at all | understanding and protecting all people and nature |
| 20 | `realistic` | interests | not at all | hands-on: building things, machines, hardware, the physical world |
| 21 | `investigative` | interests | not at all | analysing, research, science, solving hard problems |
| 22 | `artistic` | interests | not at all | creating, design, writing, expression |
| 23 | `social` | interests | not at all | helping, teaching, caring for people |
| 24 | `enterprising` | interests | not at all | leading, selling, persuading, starting ventures |
| 25 | `conventional` | interests | not at all | organising data, process, operations, precision |
| 26 | `big_picture` | work | focused on details and execution | focused on vision and the big picture |
| 27 | `pace` | work | careful, deliberate | fast, ships quickly |
| 28 | `risk_tolerance` | work | cautious, avoids risk | comfortable with high risk and uncertainty |
| 29 | `autonomy` | work | prefers working in a team | prefers working alone |
| 30 | `structure` | work | improvises, dislikes process | wants clear structure and process |
| 31 | `directness` | work | diplomatic, indirect | blunt, says it straight |
| 32 | `leadership` | work | prefers to support and contribute | prefers to lead and decide |
| 33 | `maker` | work | talks, sells, coordinates | builds and makes things themselves |
| 34 | `openness_to_strangers` | networking | hesitant with new people | loves meeting new people |
| 35 | `giving` | networking | mostly here to get help (taker) | mostly here to help others (giver) |
| 36 | `collaboration_appetite` | networking | not looking to work with anyone | actively wants collaborators |
| 37 | `mentoring` | networking | not at all | keen to teach and mentor others |
| 38 | `learning` | networking | not at all | keen to learn from more experienced people |
| 39 | `playfulness` | networking | serious, formal | playful, humorous |
| 40 | `seniority` | career | student or early career | very senior, executive or veteran |
| 41 | `technical` | career | non-technical | deeply technical |
| 42 | `entrepreneurial` | career | employee mindset | founder, builds ventures |
| 43 | `urgency` | career | no pressing need right now | needs something urgently, this week |

Sources for the groups: Big Five, HEXACO's honesty-humility and four IPIP-NEO facets (personality); Schwartz's ten
basic human values (values); Holland's RIASEC (interests). Work, networking and career are ours, for introductions.

## Using them well

- **Weigh by confidence.** A dimension with confidence 0.1 is a guess. A natural weight for comparing two people
  on dimension k is `c_a[k] * c_b[k]`.
- **Similarity or complementarity.** Research on professional ties points both ways, depending on the dimension:
  - *similar works*: values (value homophily predicts who forms ties), most of personality, pace, playfulness;
  - *complementary works*: skills and roles: `maker` vs a seller, `mentoring` vs `learning`, `giving`, often
    `big_picture` vs detail; and above all one person's `goals.looking_for` against the other's `offers`
    (skill complementarity predicts productive collaboration).
- **Accuracy is modest.** LLMs reading personality from text agree with real tests at about r = .29 (Peters & Matz,
  PNAS Nexus 2024); readings are stable but not psychometric. Good for ranking and matching, not for telling
  anyone who they are.

## Privacy

The write-up and the persona are never shown to anyone. A person sees only their summary (and, for the demo, their
own numbers in Settings). Other people never see anyone's traits.

