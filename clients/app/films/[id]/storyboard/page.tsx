'use client';
import { use } from 'react';
import { StoryboardWorkspace } from '../../../../components/storyboard';
/** Film-scoped planning workspace; authentication and data stay behind the server API. */
export default function StoryboardPage({params}:{params:Promise<{id:string}>}){const {id}=use(params);return <StoryboardWorkspace filmId={id}/>;}
