'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { BackgroundOrbs } from '@/components/sections/BackgroundOrbs'
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

const LeadForm = dynamic(
  () => import('@/components/sections/LeadForm').then((mod) => ({ default: mod.LeadForm })),
  { ssr: false }
)

export function LandingClient() {
  const [leadOpen, setLeadOpen] = useState(false)

  function openLead() {
    setLeadOpen(true)
  }

  function closeLead() {
    setLeadOpen(false)
  }

  return (
    <>
      <BackgroundOrbs />
      <Navbar onOpenLead={openLead} />

      <main id="inicio">
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
      <LeadForm open={leadOpen} onClose={closeLead} />
    </>
  )
}
