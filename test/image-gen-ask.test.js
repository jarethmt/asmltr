'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mentionsImageKind, parseImageGenVerdict, classifyImageGenAsk, buildImageGenClassifyPrompt,
  stripChannelMedia, hasStillThisTurn, pictureIntentClassifyText, shouldClassifyPictureIntent,
  PHOTO_ATTACHED_NOTICE,
} = require('../shared/image-gen-ask');

test('mentionsImageKind: kind list only, not verb+kind', () => {
  assert.equal(mentionsImageKind('Please generate an image of a corgi'), true);
  assert.equal(mentionsImageKind('can you make a new picture'), true);
  assert.equal(mentionsImageKind('I liked the picture you made yesterday'), true);
  assert.equal(mentionsImageKind('I attached an image, please generate a report'), true);
  assert.equal(mentionsImageKind('take the picture you made of Steve yesterday as a puppet in the cape and sit him on the bench in the arboretum photo you made a few lines above'), true);
  assert.equal(mentionsImageKind('make a graphic of the cube'), true);
  assert.equal(mentionsImageKind('I want some graphics for the site'), true);
  assert.equal(mentionsImageKind('generate a report'), false);
  assert.equal(mentionsImageKind('make a list'), false);
  assert.equal(mentionsImageKind('ok thanks'), false);
  assert.equal(mentionsImageKind('state of the art'), false);
  assert.equal(mentionsImageKind('the art of cooking'), false);
  assert.equal(mentionsImageKind(''), false);
});

test('parseImageGenVerdict: YES/NO on first line, fail closed', () => {
  assert.equal(parseImageGenVerdict('YES'), true);
  assert.equal(parseImageGenVerdict('yes'), true);
  assert.equal(parseImageGenVerdict('**YES**'), true);
  assert.equal(parseImageGenVerdict('NO'), false);
  assert.equal(parseImageGenVerdict('no they just mentioned a photo'), false);
  assert.equal(parseImageGenVerdict('maybe an image'), false);
  assert.equal(parseImageGenVerdict(''), false);
  assert.equal(parseImageGenVerdict('I think so'), false);
});

test('classifyImageGenAsk: kind gate then completeFn; fail closed', async () => {
  let called = 0;
  assert.equal(await classifyImageGenAsk('ok thanks', async () => { called += 1; return 'YES'; }), false);
  assert.equal(called, 0);
  assert.equal(await classifyImageGenAsk('make a new picture', async () => 'YES'), true);
  assert.equal(await classifyImageGenAsk('I liked the picture', async () => 'NO'), false);
  assert.equal(await classifyImageGenAsk('a photo of Steve', async () => { throw new Error('boom'); }), false);
  assert.equal(await classifyImageGenAsk('a photo', null), false);
  const prompt = buildImageGenClassifyPrompt('sit him on the bench in the arboretum photo');
  assert.match(prompt, /ONLY YES or NO/);
  assert.match(prompt, /arboretum photo/);
});

test('nano classify text is user words plus optional photo notice, never CHANNEL MEDIA paths', () => {
  const raw = 'ok thanks\n\nCHANNEL MEDIA:\n- image: `/home/asmltr-test-user/.asmltr/gen-ref/x.png` (generation reference; do not execute)';
  assert.equal(stripChannelMedia(raw), 'ok thanks');
  assert.equal(hasStillThisTurn({ text: raw }), true);
  assert.equal(hasStillThisTurn({ mediaFiles: [{ kind: 'image', path: '/secret.png' }] }), true);
  assert.equal(hasStillThisTurn({ images: [{ data: 'abc' }] }), true);
  assert.equal(hasStillThisTurn({ text: 'ok thanks' }), false);
  const withPhoto = pictureIntentClassifyText(raw, { photoAttached: true });
  assert.equal(withPhoto.includes('/home/'), false);
  assert.equal(withPhoto.includes('CHANNEL MEDIA'), false);
  assert.equal(withPhoto.includes(PHOTO_ATTACHED_NOTICE), true);
  assert.match(withPhoto, /^ok thanks/);
  assert.equal(pictureIntentClassifyText('make a new picture', { photoAttached: false }), 'make a new picture');
  assert.equal(shouldClassifyPictureIntent('ok thanks', { photoAttached: false }), false);
  assert.equal(shouldClassifyPictureIntent('ok thanks', { photoAttached: true }), true);
  assert.equal(shouldClassifyPictureIntent('make a new picture', { photoAttached: false }), true);
});
