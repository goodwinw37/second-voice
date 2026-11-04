// The pressure tactics the coach listens for.
//
// Each tactic is something a caller DOES, not something about how they sound.
// That is deliberate: it keeps working when the voice is a perfect clone, and it
// complements audio-level deepfake detection rather than competing with it.

export type TacticId =
  | "secrecy"
  | "coached_lie"
  | "credentials"
  | "safe_account"
  | "untraceable_payment"
  | "remote_access"
  | "advance_fee"
  | "identity_number"
  | "device_alarm"
  | "threat"
  | "bank_details"
  | "money_request"
  | "family_emergency"
  | "urgency"
  | "stay_on_line"
  | "personal_details"
  | "alarm"
  | "too_good"
  | "device_steering"
  | "prize_claim"
  | "official_props"
  | "scam_denial";

export interface Tactic {
  id: TacticId;
  /** Short label shown on screen and in the post-call summary. */
  label: string;
  /** How much this adds to the call's risk score. Each tactic counts once. */
  weight: number;
  /** True if this alone is enough to tell someone to hang up. */
  decisive: boolean;
  /** Protective wording ("we will never ask for your PIN") must not count as asking. */
  guarded: boolean;
  patterns: RegExp[];
  /** A clause matching this does not count, even if a pattern matches it. */
  except?: RegExp;
  /** Example sentences for the semantic matcher, to catch rewordings the patterns miss. */
  exemplars: string[];
}

/** A caller inviting you to check them ("verify my identity") is doing the opposite of asking for yours. */
const CALLER_OFFERS_ID =
  /^(?!.*\byour\s+(\w+\s+)?(social|ssn|national|ni\b|passport|date|birth|full|name|address|mother|maiden|licen[cs]e|personal|identity|details|information)).*(\b(verify(ing)?|confirm(ing)?|check(ing)?)\s+(my|who i)\b|\bmy\s+(employee|staff|agent)\b)/i;

export const TACTICS: Tactic[] = [
  {
    id: "credentials",
    label: "Asked for a PIN, code or password",
    weight: 5,
    decisive: true,
    guarded: true,
    patterns: [
      // These need a verb asking for the thing. Merely mentioning a password must never be enough
      // to tell someone to hang up: a false "hang up" is the most costly mistake the coach can make.
      // "Give me the code" is an ask. "I'll give you the code" is an offer, so neither "I'll give" nor
      // "give you" counts. A post code or a door code isn't a secret, so those don't count either.
      /((?<!\b(i|we|i'?ll|we'?ll|i will|we will|let me|i'?m going to|we'?re going to)( just| can| could)? )\b(read|give|tell|send|say|provide)\b(?!\s+you\b)|\b(confirm|what'?s|what is|enter|type|key in|input)\b|(?<!\b(you'?ll|you will) )\b(need|want)\b)((?!\b(give|send|provide|tell)\s+you\b).){0,40}(?<!\b(post|postal|zip|area|dress|gate|door|error|fault|alarm|sort|sword|discount|promo|promotional|referral|coupon|tracking|qr|bar|wi-?fi|boiler)[ -])\b(pin(?! down)|passcode|password|code(?! for (the|your) (gate|door|key|alarm|wi-?fi|boiler))|otp|cvv|cvc|card number|long number|card details|login|log-?in details|(?<!\bsocial )security number|verification number|memorable word)\b/i,
      // "Read it to me" is an ask. "Would you like me to read it out?" and "Let me read that back" are offers.
      /(?<!\b(i|we|me|me to|us to|i'?ll|we'?ll|i can|can i|shall i|just to|will)( just)? )\bread (it|that|them|those|this)\b.{0,12}\b(back|out|to me)\b/i,
      /\b(three|3)[- ]digit(s)?\b.{0,30}\b(back|card)\b/i,
      // "Can I have your PIN?" is the commonest way to ask, and has none of the verbs above.
      /\b(can|could|may|let)\s+(i|we|me|us)\s+(just\s+|please\s+)?(have|take|get|grab)\b.{0,25}\b(your|the|that|those)\b.{0,15}\b(pin(?! down)|passcode|password|cvv|cvc|otp|card number|long number|card details|memorable word|(?<!\b(post|zip|gate|door|sort|sword|promo|referral|discount|tracking)[ -])code)\b|^\W*and\s+(your|the)\s+(\w+\s+)?(pin|passcode|password|cvv|cvc|otp|code|card number|long number|memorable word)(\s+is)?\W*$|^\W*(your|the)\s+(\w+\s+)?(pin|passcode|password|cvv|cvc|otp|code|card number|long number|memorable word)\W+please\W*$/i,
      /\b(share|pass|spell( out)?)\b.{0,25}\b(pin|passcode|password|code|otp|cvv|cvc|memorable word)\b.{0,20}\b(with|to|over to|for) (me|us)\b|\b(telling|giving|reading)\s+(me|us)\b.{0,25}\b(pin|passcode|password|code|otp|cvv|cvc|card number|memorable word)\b/i,
      /\bread me the numbers?\b|\bwhat (the|that) (text|message) says\b|\bapprove the (notification|payment|request)\b/i,
    ],
    // Quoting the last four digits is a common way for a genuine caller to identify a card, unless they
    // want a secret in the same breath. A caller offering to read something out isn't asking for anything.
    except:
      /^(?!.*\b(pin|password|passcode|cvv|cvc|otp|code|memorable word|login|expiry|security number|long number|card details)\b)(?!.*\bcard number\b.*\blast (four|4)\b)(?:.*\blast (four|4)( digits| numbers)?\b|.*\b(would you like|do you want|shall|should) (me|us|i|we)\b.{0,40}\bread\b)/i,
    exemplars: [
      "Can you read me the code we just sent to your phone?",
      "I need the six digit number from the text message.",
      "Please tell me your online banking password so I can secure it.",
      "What is the long number across the front of your card?",
      "Give me the three digits on the back of your card.",
      "To cancel the payment I need your PIN.",
    ],
  },
  {
    id: "safe_account",
    label: "Asked you to move money to a 'safe' account",
    weight: 5,
    decisive: true,
    guarded: true,
    patterns: [
      /\b(safe|secure|holding|protected|temporary)\s+(bank\s+)?account\b.{0,60}\b(move|moving|transfer|send|sending|put|funds?|money|savings)\b/i,
      /\b(move|moving|transfer|transferring|send|sending|put)\b.{0,60}\b(safe|secure|holding|protected|temporary)\s+(bank\s+)?account\b/i,
      /(?<!would you like to )\b(move|transfer)\b.{0,30}\b(your|all (of )?your)\s+(money|savings|funds)\b/i,
    ],
    // Moving a tenancy deposit into a protected scheme is routine, and it isn't someone's savings.
    except: /^(?!.*\b(savings|funds|balance|cash)\b).*\b(your|the|tenancy|rental|rent) deposit\b/i,
    exemplars: [
      "You need to transfer your savings to a safe account we have set up for you.",
      "Move all of your money into this new secure account before the criminals take it.",
      "We have created a holding account to protect your funds, please send the balance there.",
    ],
  },
  {
    id: "untraceable_payment",
    label: "Asked for a payment that's hard to get back",
    weight: 5,
    decisive: true,
    guarded: true,
    patterns: [
      /\b(gift|itunes|apple|google play|steam|amazon)[\s-]*(gift[\s-]*)?(card|voucher)s?\b.{0,50}\b(buy|purchase|code|codes|pay|payment|scratch|read)\b/i,
      /\b(buy|purchase|pay|paying|payment|pick up|get)\b.{0,50}\b(gift|itunes|apple|google play|steam)[\s-]*(gift[\s-]*)?(card|voucher)s?\b(?!.{0,30}\bbirthday\b)/i,
      /\b(bitcoin|crypto|cryptocurrency|usdt|ethereum)\b.{0,40}\b(pay|send|buy|deposit|transfer|atm|wallet)\b/i,
      /\b(pay|send|buy|deposit|transfer)\b.{0,40}\b(bitcoin|crypto|cryptocurrency|usdt|ethereum)\b/i,
      // Being told to pay this way. "I got a wire transfer from Dad" isn't an ask.
      /\b(need to|have to|has to|must|please|only|just)\b.{0,40}\b(western union|moneygram|wire transfer)\b|\b(send|pay)\s+(it|them|the money|this)\s+(by|through|via)\s+(western union|moneygram|wire transfer)\b|\bwire the money\b/i,
      /\b(courier|officer)\b.{0,50}\b(collect|pick up|come for)\b.{0,30}\b(cash|money|card|cards)\b/i,
      /\b(withdraw|take out)\b.{0,30}\b(cash|money)\b.{0,50}\b(courier|collect|hand|officer|evidence)\b/i,
      // Courier fraud, in the order people usually say it: "put your card in an envelope, and a courier will collect it".
      /\b(card|cards|cash|money)\b.{0,40}\b(envelope|courier|officer)\b.{0,40}\b(collect|pick|come (by|for)|come and)\b/i,
    ],
    // A gift card offered as a sign-up or referral reward is sales talk. Being told to buy one, or to read its code, is not.
    except:
      /^(?!.*\b(codes?|scratch|read)\b)(?!.*\b(buy|purchase|pick up)\s+([\w$£-]+\s+){0,4}(gift|itunes|apple|google play|steam)\b).*(\b(receive|earn|reward|bonus|offering)\b.{0,25}\bgift[\s-]*cards?\b|\b(you|they)('?ll| will)\s+(both\s+|also\s+)?get\s+(an?\b|the\s+[$£]\d).{0,12}\bgift[\s-]*cards?\b)/i,
    exemplars: [
      "Go to the shop, buy five hundred pounds of gift cards and read me the codes on the back.",
      "You can settle this by depositing cash into a Bitcoin machine.",
      "Withdraw the cash and our courier will collect it from your house.",
      "The payment has to be made by wire transfer through Western Union.",
    ],
  },
  {
    id: "remote_access",
    label: "Asked to control your device",
    weight: 5,
    decisive: true,
    guarded: true,
    patterns: [
      /\b(anydesk|any desk|teamviewer|team viewer|quicksupport|ultraviewer|logmein)\b/i,
      /\bremote(ly)?\s+(access|session|connection|desktop|connect\w*)\b|\b(let me|i can|i'?ll|i will|we can|we'?ll|going to|need to)\s+remote\s+in(to)?\b|\bremote(ly)? control (of )?(your|the) (computer|laptop|phone|screen|device|pc)\b/i,
      /\b(access|connect to|log ?in to|control( of)?)\s+(your|the)\s+(computer|laptop|phone|screen|device|pc)\b|\b(get|got|getting|log|remote) into\s+your\s+(computer|laptop|phone|screen|device|pc)\b/i,
      /\b(fix|repair|clean|remove)\b.{0,25}\bremotely\b/i,
      /\b(event viewer|command prompt|run box|task manager)\b/i,
      /\b(download|install)\b.{0,30}\b(software|program|app|application|tool|file)\b.{0,50}\b(fix|remove|clean|secure|protect|so (that )?(i|we) can (see|access|control|fix|get into) (your|the))\b/i,
    ],
    exemplars: [
      "Please download this small app so that I can see your screen and fix the problem.",
      "I need to connect to your computer to remove the virus.",
      "Let me take control of your laptop for a moment.",
    ],
  },
  {
    id: "coached_lie",
    label: "Told you what to say to the bank",
    weight: 5,
    decisive: true,
    guarded: false,
    patterns: [
      // "If the bank asks, say..." is enough. "If anyone asks, say he's with me" isn't, so that needs money or a cover story too.
      /\bif\b.{0,25}\b(bank|cashier|teller|staff|branch)\b.{0,15}\b(asks?|questions?|calls?|wants? to know)\b.{0,40}\b(say|tell|just|it'?s|its)\b/i,
      /\bif\b.{0,25}\b(anyone|they|someone)\b.{0,15}\b(asks?|questions?|calls?|wants? to know)\b.{0,40}\b(say|tell|just|it'?s|its)\b.{0,40}\b(money|payment|transfer|gift|holiday|home improvements?|building work|renovation|family|friend|relative|car)\b/i,
      /\b(tell|say to)\s+(them|the (bank|cashier|teller|staff))\b.{0,40}\b(holiday|home improvements?|family|building work|renovation|friend|relative)\b/i,
      /\b(tell|say to)\s+the (bank|cashier|teller|staff)\b.{0,40}\b(for|it'?s|its)\b/i,
      /\b(say|tell (them|the bank))\b.{0,20}\b(it'?s|its|that it'?s|that its)\s+(for (a |your )?(holiday|home|family|building|car|gift|relative|friend|renovation)|a gift|your own)\b/i,
    ],
    exemplars: [
      "If the cashier asks why, say the money is for home improvements.",
      "Tell the bank this payment is for a family member so they do not block it.",
      "The teller might ask questions, just say it is for a holiday.",
    ],
  },
  {
    id: "secrecy",
    label: "Tried to cut you off from others",
    weight: 3,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(don'?t|do not|never|must not|mustn'?t|can'?t|cannot|shouldn'?t|should not|not to)\s+(\w+\s+){0,2}(tell|mention|talk to|speak to|discuss|inform|contact|say anything to|call)\b.{0,50}\b(any ?one|anybody|nobody|no ?one|family|friends?|husband|wife|partner|son|daughter|dad|mum|mom|staff|branch|bank|police|cashier|teller|neighbou?rs?|kids?|children)\b/i,
      /\b(keep|kept)\s+(this|it|that)\b.{0,30}\b(secret|confidential|private|between us|to yourself|quiet)\b/i,
      /\b(this|it|that)('?s| is)?\s+(strictly|highly) confidential\b/i,
      /\bbetween you and me\b|\b(stay|keep|this is|it'?s)\b.{0,15}\bbetween (us|ourselves)\b/i,
      /\b(staff|cashier|teller|branch|someone at the bank)\b.{0,50}\b(involved|in on it|part of|can'?t be trusted|cannot be trusted|might be (involved|in on it|part of))\b/i,
    ],
    // A surprise party is a secret, and a bank saying "don't tell anyone your PIN" is giving good advice.
    except: /\b(surprise|party|present|birthday)\b|\b(tell|share|give)\s+(any ?one|anybody|no ?one|nobody)\s+(your|the)\s+(pin|password|passcode|code|details|card)\b/i,
    exemplars: [
      "It is very important that you do not discuss this with anyone.",
      "We believe staff at your branch are involved, so say nothing to them.",
      "This has to stay between the two of us for now.",
      "Please do not let your family know about this call.",
    ],
  },
  {
    id: "advance_fee",
    label: "Asked for a fee up front",
    weight: 3,
    decisive: false,
    guarded: true,
    patterns: [
      /\b(small|processing|handling|release|admin|administration|shipping|clearance|activation|customs|upfront|up[- ]front)\s+(fee|charge)\b/i,
      /\b(pay|payment of)\b.{0,30}\b(fee|tax|deposit)\b.{0,40}\b(prize|refund|winnings?|reward|release|receive|claim|gift|award)\b/i,
      /\b(prize|refund|winnings?|reward|award|gift)\b.{0,60}\b(pay|cover)\b.{0,30}\b(fee|tax|charge|deposit)\b/i,
    ],
    // Getting money back under a guarantee is not paying to receive it.
    except: /^(?!.*\b(fee|charge)\b).*(\bmoney[- ]back guarantee\b|\bpro[- ]?rated\b|\bpro rata\b)/i,
    exemplars: [
      "To claim your prize you only have to cover a small processing fee.",
      "We can release the refund as soon as you pay the release charge.",
      "There is a fifty pound fee before we can send you your winnings.",
    ],
  },
  {
    id: "identity_number",
    label: "Asked for an identity number",
    weight: 3,
    decisive: false,
    guarded: true,
    patterns: [
      /\b(need|provide|confirm|verify|give|tell|what'?s|what is|read|just)\b.{0,60}\b(social security number|ssn|national insurance number|ni number|passport number)\b/i,
      /\b(social security number|ssn|national insurance number|ni number)\b.{0,30}\b(please|to verify|to confirm|for verification)\b/i,
    ],
    // Similarity can't tell whose number it is, and an office answering the phone says its own name.
    except: new RegExp(`${CALLER_OFFERS_ID.source}|^(?!.*\\byour\\s+(\\w+\\s+)?(social|ssn|national|ni\\b|passport|date|birth|full|name|address|mother|maiden|licen[cs]e|personal|identity|details|information))(?:(thank you|thanks) for (calling|holding)\\b(?!.*\\b(need|give|confirm|verify|provide|tell|what)\\b)|.*\\bmy\\s+(\\w+\\s+)?(id|badge)\\b)`, "i"),
    exemplars: [
      "Just give me your name, address and social security number to verify you.",
      "To reactivate it, please confirm your national insurance number.",
      "All I need is the last four digits of your social security number.",
    ],
  },
  {
    id: "device_alarm",
    label: "Claimed to see a problem on your device",
    weight: 3,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(virus|malware|hackers?|infected|spyware|trojan)\b.{0,40}\b(your|the)\s+(computer|laptop|router|pc|device|phone|system|broadband)\b/i,
      /\b(your|the)\s+(computer|laptop|router|pc|device|system)\b.{0,40}\b(virus|malware|hacked|hackers?|infected|spyware|trojan)\b/i,
      /\b(calling|call|ringing)\b.{0,20}\b(from|on behalf of)\b.{0,25}\b(microsoft|windows)\b/i,
      /\b(microsoft|windows)\b.{0,12}\b(technical |tech )?support\b/i,
    ],
    exemplars: [
      "Our systems show your computer has been infected and is sending out errors.",
      "We can see that hackers have got into your broadband connection.",
      "I am calling from the technical department about the problem with your laptop.",
    ],
  },
  {
    id: "bank_details",
    label: "Asked for your bank details",
    weight: 2,
    decisive: false,
    guarded: true,
    patterns: [
      /\b(your|the)\s+(bank(ing)?\s+(account|details|information|info)|account number|account details|routing number|sort code)\b/i,
      /\b(credit|debit)\s+card\s+(number|details|information|info)\b/i,
      /\b(need|have|take|get)\b.{0,20}\b(your|the)\s+(credit|debit)\s+card\b/i,
      /\b(confirm|verify|provide|give)\b.{0,25}\b(your\s+)?account\s+(information|info|details)\b/i,
    ],
    except: /\b(automatic|automatically|deduct\w*|draft)\b.{0,60}\bfrom your\b/i,
    exemplars: [
      "I just need your sort code and account number to process the refund.",
      "Which bank do you use, and what are your account details?",
      "Can you confirm the debit card you would like the money sent to?",
    ],
  },
  {
    id: "threat",
    label: "Threatened you",
    weight: 2,
    decisive: false,
    guarded: true,
    patterns: [
      /\b(arrest(ed)?|warrant|prosecut\w+|prison(?! officer)|jail|deport\w*|bailiffs?|lawsuit|legal action|court action|criminal charges?|taken to court|police (will|are going to))\b/i,
      /\b(your|the)\s+(account|number|social security number|ni number|national insurance number)\b.{0,30}\b(suspended|frozen|blocked|closed|cancelled|canceled|terminated|cut off)\b/i,
      /\b(account|card|number|it)('?s|\s+has|\s+have|\s+is)?\s+(been\s+)?(suspended|frozen|blocked)\b/i,
      /\b(suspend|suspending|freeze|freezing|block|blocking|cancel|cancelling|canceling|terminate|terminating)\b.{0,20}\byour\s+(social security number|ssn|ni number|national insurance number)\b/i,
      /\b(criminal|illegal)\s+activit(y|ies)\b/i,
      /\b(lose|losing|lost)\s+(all\s+)?(of\s+)?your\s+(money|savings|funds|benefits|home)\b/i,
      /\b(money|savings|funds)\b.{0,20}\b(will be|is going to be|'?ll be)\s+(gone|lost|taken|stolen)\b/i,
    ],
    exemplars: [
      "If you do not cooperate there will be serious legal consequences for you.",
      "Officers will be at your door this afternoon unless this is settled.",
      "If you hang up, your money will be gone by tonight.",
      "Your name has come up in a criminal investigation.",
    ],
  },
  {
    id: "money_request",
    label: "Asked you to send money",
    weight: 2,
    decisive: false,
    guarded: true,
    patterns: [
      /\b(can you|could you|would you|need you to|you need to|you have to|you must|please|i need)\b.{0,20}\b(send|transfer|wire|lend|give me|pay)\b.{0,40}\b(pounds?|money|dollars|quid|grand|hundred|thousand|£|\$|\d)/i,
    ],
    exemplars: [
      "Can you send sixteen hundred pounds to my landlord for me?",
      "You have to transfer two thousand pounds to him today.",
    ],
  },
  {
    id: "family_emergency",
    label: "Said they were family",
    weight: 2,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(mum|mom|dad|nan|nana|gran|granny|grandma|grandad|grandpa)\b.{0,40}\b(it'?s me|its me|i'?m in trouble|i'?ve been|i was|need your help|help me)\b/i,
      /\b(it'?s me|its me)\b.{0,40}\b(mum|mom|dad|nan|gran|grandma|grandad|grandpa)\b/i,
      /\b(lost|broke|smashed|dropped|stolen)\b.{0,15}\b(my )?phone\b.{0,60}\b(new number|this number|borrow|friend'?s phone|someone'?s phone|money|need)\b/i,
      /\b(new number|friend'?s phone|someone else'?s phone)\b.{0,60}\b(money|pay|send|transfer|help|bill|rent|bail)\b/i,
      /\b(i'?m|i am|i'?ve been)\b.{0,30}\b(in trouble|arrested|in an accident|in a crash|in hospital|stranded|locked out of my bank)\b.{0,60}\b(money|pay|send|transfer|bail|need)\b/i,
    ],
    exemplars: [
      "Mum, it is me, I am using a friend's phone and I really need you to send me some money.",
      "I have been in an accident and I need money right away, please do not be angry.",
      "I can't get into my banking app so can you pay this bill for me just this once?",
    ],
  },
  {
    id: "urgency",
    label: "Rushed you",
    weight: 1,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(right now|right away|immediately|straight away|at once|as soon as possible|asap|urgent(ly)?|before it'?s too late|time is running out|no time|running out of time|last chance|act now|act fast|act quickly|within the (next )?(hour|\d+ minutes|few minutes|\w+ minutes)|in the next (\d+|\w+) minutes)\b/i,
    ],
    // These words also describe a shop's current offers, or a promise of quick service. That isn't rushing anyone.
    except:
      /\b(offers?|deals?|sale|promotions?|discounts?|policy|insurance|cover|plan|contract)\b.{0,30}\b(going on|in place) right now\b|\bright now,? (we'?re|we are) offering\b|\b(from|off) (our|the) (\w+ )?list\b.{0,20}\b(immediately|right away)\b|\bnot (looking|interested|thinking|ready)\b(?!.*\bdo (it|this|that)\b).{0,40}\bright now\b|^(?!.*\b(need|needs|must|have to|has to|got to|should|require[sd]?|or else|otherwise|unless|before|if|only|once)\b).*\b(we'll|we will|i'll|i will|we can|i can)\b.{0,50}\b(right away|as soon as possible)\b/i,
    exemplars: [
      "We have to deal with this in the next few minutes or it will be too late.",
      "There is no time to think about it, you have to decide now.",
      "This offer expires today so you need to act quickly.",
    ],
  },
  {
    id: "stay_on_line",
    label: "Told you not to hang up",
    weight: 1,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(don'?t|do not|please don'?t|must not|never)\s+(hang up|put the phone down|end (this|the) call|disconnect)\b/i,
      /\b(stay|remain|keep me|keep this)\s+on\s+(the\s+)?(line|phone|call)\b/i,
    ],
    exemplars: [
      "Whatever you do, keep me on the phone while you go to the bank.",
      "You must not end this call until the process is complete.",
    ],
  },
  {
    id: "personal_details",
    label: "Asked for personal details",
    weight: 1,
    decisive: false,
    guarded: true,
    patterns: [
      /\b(mother'?s maiden name|date of birth|driving licen[cs]e number)\b/i,
      // "Your" or "some" is required: "confirm the details of your delivery" and "verify my identity" are not asks.
      /\b(verify|confirm)\b.{0,25}\b(your|some|personal)\s+(personal\s+)?(information|identity|details)\b/i,
      /\b(confirm|verify|provide|need)\b.{0,25}\byour\s+(full name|name and address|name, address|(\w+\s+){0,3}address)\b/i,
    ],
    except: CALLER_OFFERS_ID,
    exemplars: [
      "Can you confirm your full name, address and when you were born?",
      "To verify you I need the last four digits of your social security number.",
    ],
  },
  {
    id: "alarm",
    label: "Raised an alarm about your account or device",
    weight: 1,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(account|card|identity|computer|laptop|router|social security number|ssn)\b.{0,50}\b(compromised|hacked|infected|stolen|breached|fraud|suspicious|at risk)\b/i,
      /\b(compromised|hacked|infected|stolen|breached|fraudulent|suspicious activity|virus|malware)\b.{0,50}\b(your|account|card|identity|computer|laptop|router)\b/i,
    ],
    exemplars: [
      "We have detected that criminals are trying to take money from your account right now.",
      "Your computer has been sending out error messages and hackers have got in.",
    ],
  },
  {
    id: "too_good",
    label: "Offered unexpected money",
    weight: 2,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(you'?ve|you have|you)\s+(been\s+)?(selected|chosen)\b/i,
      /\bcongratulations\b\s*[!.]*\s*$|\bcongratulations\b.{0,60}\b(win|won|winning|winner|prize|reward|selected|chosen|cash)\b/i,
      /\b(eligible|entitled|due|owed)\b.{0,20}\b(refund|rebate|compensation|reward|prize|money back)\b/i,
      /\b(refund you|issue (you )?a refund|offer you a refund|process (the|your) refund|overcharged)\b/i,
    ],
    exemplars: [
      "Good news, you have been picked to receive a cash reward.",
      "Our records show you were overcharged and we owe you a large refund.",
    ],
  },
  {
    // An unprompted caller walking someone around their own computer. It comes before any
    // named remote tool, so it warns earlier than remote_access can.
    id: "device_steering",
    label: "Told you what to do on your computer",
    weight: 3,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(in front of|near|next to|sitting at)\s+(your|a|the)\s+(computer|laptop|pc)\b/i,
      /\b(is|get|turn)\s+(your|the)\s+(computer|laptop|pc)\s+(on|turned on|switched on)\b/i,
      /\b(open|launch)\b.{0,15}\b(google chrome|chrome|microsoft edge|internet explorer|firefox|web ?browser|browser)\b/i,
      /\bwhich (web ?)?browser\b/i,
      /\b(windows|ctrl|control) key\b|\bwindows button\b/i,
      /\b(search box|address bar)\b/i,
      /\b(hit|press)\s+(the\s+)?enter\b/i,
    ],
    exemplars: [
      "Are you sitting at your computer at the moment?",
      "Open your web browser and type in what I spell out for you.",
      "Hold down the key with the Windows logo and press the letter R.",
    ],
  },
  {
    // Winning something you never entered. Stronger than too_good, which also covers
    // refunds that genuine companies really do call about.
    id: "prize_claim",
    label: "Said you had won a prize",
    weight: 3,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(you'?ve|you have|you)\s+(just\s+)?(been\s+)?won\b(?!['’])/i,
      /\b(receive|claim|collect|deliver\w*)\b.{0,25}\b(your|the)\s+(prize|winnings|jackpot)\b/i,
      /\b(claim(ing)?|winner'?s?|winning|prize|sweepstakes?)\s+(code|information|info|notification)\b/i,
    ],
    exemplars: [
      "Good news, you are the winner of a large cash prize in our draw.",
      "Your name came up in the sweepstakes and the money is waiting for you.",
      "I just need your claim code so we can arrange delivery of your winnings.",
    ],
  },
  {
    // Dictating a badge or ID number builds false authority. A real officer may give one
    // too, so this is mild: it adds up with other tactics and never speaks alone.
    id: "official_props",
    label: "Recited a badge or ID to seem official",
    weight: 2,
    decisive: false,
    guarded: false,
    patterns: [
      /\bbadge\s+(\w+\s+)?(id|number|code)\b/i,
      /\b(write down|note down|take down|make a note of)\b.{0,25}\bmy\s+(name|badge|federal|id|officer|employee)\b/i,
    ],
    exemplars: [
      "Please take down my name and my officer badge number.",
      "My federal identification number is seven four two, make a note of that.",
    ],
  },
  {
    // Patterns only. Examples here matched any talk of scams, including genuine callers'.
    id: "scam_denial",
    label: "Insisted this was not a scam",
    weight: 1,
    decisive: false,
    guarded: false,
    patterns: [
      /\b(this|it|that)(\s+is\s+not|\s+isn'?t|'?s\s+not)\s+(a|an|any)\s+(scam|scheme|fraud|hoax|con)\b/i,
      /\b(i'?m|i am)\s+not\s+a\s+(scammer|fraudster|con\s?man)\b/i,
    ],
    exemplars: [],
  },
];

/**
 * Things genuine callers say. The semantic matcher treats these as a competing
 * class, so ordinary or protective sentences are not pulled towards a tactic
 * just because they share vocabulary with it.
 */
export const SAFE_EXEMPLARS: string[] = [
  "We will never ask you for your PIN or your full password.",
  "Never share this code with anyone, including us.",
  "Please do not give your card details to anyone who calls you.",
  "If you would like to check, hang up and call the number on the back of your card.",
  "You can call us back whenever suits you.",
  "Take your time, there is no rush at all.",
  "I am calling to remind you about your appointment on Tuesday.",
  "Your parcel will be delivered this afternoon between two and four.",
  "Sorry, I think I have the wrong number.",
  "Can I just check whether this is still a good time to talk?",
  "Would you be interested in hearing about our home insurance policies?",
  "We have a special offer on home security systems this month.",
  "How much does your current policy cost you each year?",
  "Could you tell me which day is best for the engineer to visit?",
  "Are you happy for me to send you some information by post?",
  "Did you make a payment of forty pounds to this shop yesterday?",
  "I will leave the parcel with your neighbour if you are out.",
  "Hi, it is me, just letting you know I got home safely.",
  "Can you pick me up from the station at six?",
  "No problem at all, thank you for your time and have a nice day.",
  "It looks like we made a mistake on our system.",
  "We can set up a monthly payment plan to suit your budget.",
  "We have noticed some suspicious activity on your account.",
  "We have noticed a problem on your account.",
];

/**
 * Protective wording. A clause matching this says the caller will NOT ask for something, so it
 * does not count for guarded tactics. It only excuses that one clause, and only when the negation
 * comes straight before the verb: "don't worry and tell me the code" is still an ask, and so is
 * "if you don't pay". A scammer could still hide an ask inside this wording. That is a known gap.
 */
export const PROTECTIVE_WORDING =
  /(?<!\b(if you|or you|why|so we|so i|and you) )\b(never|won'?t|will not|wouldn'?t|would not|don'?t|do not|not going to|no need to|don'?t need|do not need|shouldn'?t|should not|must not|mustn'?t|no one( \w+){0,3} will|nobody( \w+){0,3} will|not asking( you)?( to)?)\W+((ever|you|need to|have to|be|under any circumstances|(call|phone|ring|text|contact|email)( you| customers)?( and)?)\W+)*(ask|asked|asking|give|giving|share|sharing|tell(?!\s+(?:anyone|anybody|(?:the|your)\s+\w+)(?:\s+about\b|\s*,))|read|need(?! to)|require|say|send|hand|pass|disclose|provide|pay|install|download|move|transfer)\b/i;
