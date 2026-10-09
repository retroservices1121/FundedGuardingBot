import { hashReviewPassword } from '../src/review-login.js';
// Pipe the password through stdin; never pass it as a command-line argument.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
console.log(await hashReviewPassword(password));
