import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
export const metadata:Metadata={title:'Nolen · Film production',description:'Local short-film production assistant'};
/** Restrained shell shared by create/read and unlock screens. */
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}><body><header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between"><span className="font-semibold tracking-tight">NOLEN <span className="text-zinc-400 font-normal">/ Film studio</span></span><span className="text-xs text-zinc-400">Local workspace</span></header><main>{children}</main></body></html>;
}
