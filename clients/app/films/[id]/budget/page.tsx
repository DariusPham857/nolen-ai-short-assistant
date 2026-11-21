'use client';
import { use } from 'react';
import { BudgetWorkspace } from '../../../../components/budget';

export default function BudgetPage({params}:{params:Promise<{id:string}>}){const {id}=use(params);return <BudgetWorkspace filmId={id}/>;}

