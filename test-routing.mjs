#!/usr/bin/env node
// Unit test for the shared-bot demux (src/routing.ts). Pure — no broker, no
// Telegram, no ADAPT. Validates chat-key normalization and the topic->whole-chat
// ->catch-all resolution order that makes "one bot, many chats/topics" route
// correctly and reverse-deliver unambiguously.
//
// Run: node_modules/.bin/tsx test-routing.mjs

import { chatKey, isCatchAll, resolveRoute, deliveryTarget, looksLikeBotToken, isIdCommand, formatChatIdReply } from './src/routing.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

console.log('=== routing demux unit test ===');

// chatKey normalization
assert(chatKey(-1001234567890) === '-1001234567890', 'whole-chat key is the chat id');
assert(chatKey(-100, 42) === '-100:42', 'topic key is chatId:threadId');
assert(chatKey('-100', '') === '-100', 'empty threadId collapses to whole-chat key');
assert(chatKey('-100', null) === '-100', 'null threadId collapses to whole-chat key');
assert(chatKey(-100, undefined) === '-100', 'undefined threadId collapses to whole-chat key');

// isCatchAll
assert(isCatchAll('0') === true && isCatchAll('') === true, "'0' and '' are catch-all");
assert(isCatchAll('-100') === false, 'a real chat id is not catch-all');

// resolveRoute: build a bot's exact map with mixed whole-chat and topic routes
const A = { name: 'whole-chat' };   // -100
const B = { name: 'topic-42' };     // -100:42
const D = { name: 'other-chat' };   // -200
const C = { name: 'catch-all' };

const exact = new Map([
  ['-100', A],
  ['-100:42', B],
  ['-200', D],
]);

assert(resolveRoute(exact, null, -100) === A, 'non-topic message -> whole-chat route');
assert(resolveRoute(exact, null, -100, 42) === B, 'topic message -> exact topic route (preferred over whole-chat)');
assert(resolveRoute(exact, null, -100, 99) === A, 'topic with no exact route -> falls back to whole-chat route');
assert(resolveRoute(exact, null, -200, 7) === D, 'topic in a chat with only a whole-chat route -> that route');
assert(resolveRoute(exact, null, -999) === null, 'unknown chat, no catch-all -> null');
assert(resolveRoute(exact, C, -999) === C, 'unknown chat -> catch-all when present');
assert(resolveRoute(exact, C, -999, 5) === C, 'unknown topic chat -> catch-all when present');
assert(resolveRoute(new Map(), C, -100, 5) === C, 'no exact routes at all -> catch-all');

// reverse-routing invariant: a topic-pinned route is reached ONLY by its own
// chat-key, so a reply can never cross into another topic.
assert(resolveRoute(exact, null, -100, 42) !== resolveRoute(exact, null, -100), 'topic route and whole-chat route are distinct identities');

// deliveryTarget: where an agent reply goes back
const eq = (a, b) => a && b && a.chatId === b.chatId && a.threadId === b.threadId;
assert(eq(deliveryTarget('-100', '42', null), { chatId: '-100', threadId: '42' }), 'topic-pinned route answers into its own topic');
assert(eq(deliveryTarget('-100', '42', { chatId: '-100', threadId: '9' }), { chatId: '-100', threadId: '42' }), 'topic-pinned route ignores last inbound topic');
assert(eq(deliveryTarget('-100', '', { chatId: '-100', threadId: '7' }), { chatId: '-100', threadId: '7' }), 'whole-chat route follows the last inbound topic');
assert(eq(deliveryTarget('-100', '', null), { chatId: '-100', threadId: '' }), 'whole-chat route with no inbound answers its General thread');
assert(eq(deliveryTarget('0', '', { chatId: '-5', threadId: '' }), { chatId: '-5', threadId: '' }), 'catch-all route follows the last inbound chat');
assert(deliveryTarget('0', '', null) === null, 'catch-all with no inbound has nowhere to deliver yet');

// looksLikeBotToken: lets `add_bot` accept positionals in either order by
// telling a `<bot_id>:<secret>` token apart from a friendly name.
assert(looksLikeBotToken('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11') === true, 'a real bot token is recognized');
assert(looksLikeBotToken('123456:ABC_def-789') === true, 'token with url-safe chars is recognized');
assert(looksLikeBotToken('supportbot') === false, 'a plain name is not a token');
assert(looksLikeBotToken('my bot') === false, 'a name with a space is not a token');
assert(looksLikeBotToken('abc:123') === false, 'non-numeric id is not a token');
assert(looksLikeBotToken('123456') === false, 'a bare number (no colon) is not a token');
assert(looksLikeBotToken('') === false, 'empty string is not a token');

// isIdCommand: the out-of-band /id chat-id probe. Triggers on bare `/id` and on
// `/id@<thisbot>` (the form Telegram delivers in privacy-mode groups), but never
// on `/id@<otherbot>` — so in a multi-bot group only the addressed bot answers.
assert(isIdCommand('/id', 'supportbot') === true, 'bare /id triggers');
assert(isIdCommand('/id@supportbot', 'supportbot') === true, '/id@<thisbot> triggers');
assert(isIdCommand('/id@SupportBot', 'supportbot') === true, '@bot match is case-insensitive');
assert(isIdCommand('/ID', 'supportbot') === true, 'command name is case-insensitive');
assert(isIdCommand('/id@otherbot', 'supportbot') === false, '/id@<otherbot> does NOT trigger (addressed elsewhere)');
assert(isIdCommand('/id show me the chat', 'supportbot') === true, 'trailing args are allowed after /id');
assert(isIdCommand('/id@supportbot please', 'supportbot') === true, 'trailing args allowed after /id@<bot>');
assert(isIdCommand('please /id', 'supportbot') === false, 'only triggers when /id is the first token');
assert(isIdCommand('/identity', 'supportbot') === false, '/identity is not the /id command');
assert(isIdCommand('hello', 'supportbot') === false, 'ordinary text does not trigger');
assert(isIdCommand('', 'supportbot') === false, 'empty text does not trigger');
assert(isIdCommand('/id@whatever', '') === true, 'unknown bot username: @-form accepted (best effort)');

// formatChatIdReply: a plain-text identifier dump + a ready-to-paste route command.
const wholeChat = formatChatIdReply({
  chatId: -1001234567890, chatType: 'supergroup', chatTitle: 'ACME Support', chatUsername: 'acmesupport',
  fromId: 529046075, fromLabel: 'Vitalii', botName: 'supportbot', botUsername: 'supportbot',
});
assert(wholeChat.includes('-1001234567890'), 'reply states the chat id');
assert(wholeChat.includes('supergroup'), 'reply states the chat type');
assert(wholeChat.includes('ACME Support'), 'reply states the chat title');
assert(wholeChat.includes('529046075'), 'reply states the sender user id');
assert(wholeChat.includes('--chat-id -1001234567890'), 'reply includes a ready-to-paste --chat-id');
assert(wholeChat.includes('--bot supportbot'), 'reply includes the bot name in the hint');
assert(!wholeChat.includes('--thread-id'), 'whole-chat reply omits --thread-id');

const topic = formatChatIdReply({
  chatId: -1009876543210, chatType: 'supergroup', chatTitle: 'ACME Forum',
  threadId: 42, isTopic: true, fromId: 1, botName: 'supportbot', botUsername: 'supportbot',
});
assert(topic.includes('42'), 'topic reply states the message_thread_id');
assert(topic.includes('--thread-id 42'), 'topic reply includes a ready-to-paste --thread-id');
assert(topic.includes('--chat-id -1009876543210'), 'topic reply still includes --chat-id');

console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
