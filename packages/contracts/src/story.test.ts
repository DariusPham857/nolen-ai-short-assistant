import { expect, it } from 'vitest';
import { canonicalStory, saveStorySchema, storyContentSchema, validateStorySchema } from './story.js';
it('accepts canonical input and rejects duplicate IDs, bounds, unsafe derived fields',()=>{
  const c=canonicalStory();expect(storyContentSchema.safeParse(c).success).toBe(true);
  c.scenes[0].shots[1].clientRef=c.scenes[0].shots[0].clientRef;
  expect(storyContentSchema.safeParse(c).success).toBe(false);
  expect(saveStorySchema.safeParse({expectedStoryRevisionId:null,expectedStateVersion:0,content:canonicalStory(),approved:true}).success).toBe(false);
  expect(validateStorySchema.parse({expectedStoryRevisionId:null,expectedStateVersion:0}).context).toBe('STORY_APPROVAL');
});
