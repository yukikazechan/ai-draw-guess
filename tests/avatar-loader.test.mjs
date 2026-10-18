import test from 'node:test';
import assert from 'node:assert/strict';
import {CharacterView} from '../public/avatar-loader.mjs';

test('missing optional Live2D Core does not prevent the game and AI settings modules from loading',async()=>{
  let error;const view=new CharacterView(null,{onError:value=>{error=value;}});view.setState('idle');view.setPaused(false);view.setSuspended(true);await view.load();assert.match(error.message,/Live2D/);view.destroy();
});
