import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

const buttonVariants = cva('inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:pointer-events-none disabled:opacity-50 h-10 px-4 py-2', {
  variants: { variant: {
    default: 'bg-amber-500 text-black hover:bg-amber-400',
    outline: 'border border-zinc-700 bg-zinc-950 text-zinc-100 hover:bg-zinc-800',
  } }, defaultVariants: { variant: 'default' },
});

/** Local shadcn-style primitive; forward native accessible button attributes. */
export function Button({className,variant,...props}:React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={twMerge(clsx(buttonVariants({variant}),className))} {...props}/>;
}
