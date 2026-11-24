'use client'

import { useRouter } from 'next/navigation'
import { BackgroundOrbs } from '@/components/sections/BackgroundOrbs'
import { ScrollProgress } from '@/components/sections/ScrollProgress'
import { LandingEffects } from '@/components/sections/LandingEffects'
import { Navbar } from '@/components/layout/Navbar'
import { Hero } from '@/components/sections/Hero'
import { Automation } from '@/components/sections/Automation'
import { Problems } from '@/components/sections/Problems'
import { Solutions } from '@/components/sections/Solutions'
import { Comparison } from '@/components/sections/Comparison'
import { HowItWorks } from '@/components/sections/HowItWorks'
import { AllIncluded } from '@/components/sections/AllIncluded'
import { FAQ } from '@/components/sections/FAQ'
import { FinalCTA } from '@/components/sections/FinalCTA'
import { Footer } from '@/components/layout/Footer'

export function LandingClient() {
  const router = useRouter()

  function openLead() {
    router.push('/criar-loja')
  }

  return (
    <>
      <ScrollProgress />
      <LandingEffects />
      <BackgroundOrbs />
      <Navbar onOpenLead={openLead} />

      {/* id="inicio" fica só no hero (alvo do link da marca); antes havia dois elementos com o mesmo id */}
      <main>
        <Hero onOpenLead={openLead} />
        <Automation onOpenLead={openLead} />
        <Problems />
        <Solutions />
        <Comparison onOpenLead={openLead} />
        <HowItWorks />
        <AllIncluded />
        <FAQ />
        <FinalCTA onOpenLead={openLead} />
      </main>

      <Footer onOpenLead={openLead} />
    </>
  )
}
