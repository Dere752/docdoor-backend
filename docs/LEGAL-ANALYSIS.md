# DocDoor — Legal & Regulatory Risk Analysis (Turkey)

_March 2026_

> Translated and adapted from the original analysis. **This document is for product/strategy context only and is NOT legal advice.** Operating such a platform requires working with qualified Turkish health-law, data-protection and labor-law counsel.

---

## 1. Health Regulation — the Critical Risk

The platform intermediates the delivery of healthcare, so it is directly exposed to Ministry of Health regulation.

**Existing framework.** Law 1219 (practice of medicine) sharply separates how physicians may work (public / private / own practice); public-sector physicians (Civil Servants Law 657, art. 28) may not practice independently. Law 3359 (basic health services) frames service delivery. The 2023 *Home Health Services Regulation* covers only **public** institutions; the private "send a doctor to the patient's home" model is **not defined**. The *Home Care Regulation* covers nursing/physiotherapy, not doctor consultations.

**The critical gap.** No regulation specifically permits **or** forbids a private platform dispatching a doctor to a patient's home. This gap is both the opportunity (not banned → can launch) and the existential risk (the Ministry can ban or impose heavy licensing via a bylaw — no parliamentary act required).

**Doctor employment status.** Public physicians cannot practice independently (clearly illegal to onboard). Salaried private-hospital physicians are restricted without their hospital's consent. Only **own-practice physicians** can clearly accept patients — but seeing them at home may conflict with outpatient-facility physical requirements. **Recommendation: onboard only own-practice / eligible private physicians; never public-sector physicians.**

**Licensing scenarios.** (A) Ministry accepts "platform as intermediary" → operate as a software company, no health license (Uber-style). (B) Ministry treats it as a "health-service provider" → heavy licensing (responsible physician, medical equipment, ambulance standards) → costs rise 5–10×. (C) Ministry bans → instant shutdown, refund liability, possible doctor discipline.

## 2. Company Formation & Commercial Law

- **Entity:** start as an **LLC** (low capital), convert to a **JSC** before the growth round (JSC enables share issuance / external investment / IPO).
- **Activity (NACE) codes:** 62.01 software + 63.12 web portals. **Do NOT add the medical-practice code (86.21)** — it puts the company under Ministry licensing inspection.
- **Registrations:** trade registry, tax office (corporate tax), mandatory e-invoice/e-archive, employer social-security registration when hiring.

## 3. Data Protection (KVKK)

Health data is **special-category personal data** (KVKK art. 6) with the strictest obligations.

- **Processing basis:** the platform is not a "confidentiality-bound" party, so **explicit consent** is mandatory.
- **VERBİS registration** is mandatory for any controller processing health data — no exemption.
- **Sanctions:** administrative fines up to the multi-million-₺ range (security / VERBİS breaches), plus criminal liability (imprisonment) for unlawful recording, dissemination or non-erasure of personal data.
- **Mandatory steps:** privacy policy + disclosure text; a **separate, specific explicit-consent text** for health data (consent buried in general T&Cs is invalid); VERBİS within 30 days; data-processing inventory; technical security (E2E encryption, access control, logging, backups, pen-tests); **72-hour breach-notification** procedure; retention & destruction policy; staff KVKK training.

## 4. Payments & Finance

- **Payment licensing (Law 6493):** taking funds and paying doctors directly would be a "payment service" requiring a regulator license (impractical for a startup). **Solution: operate through a licensed payment institution (e.g. iyzico/PayTR)** as a sub-merchant — licensing requirement disappears.
- **Tax:** medical services are VAT-exempt, but **intermediation commission is not** — VAT applies to the platform's commission; e-invoices required; possible income-tax withholding on payments to doctors (work with an accountant).
- **Consumer rights (Law 6502):** bookings are distance contracts; a 12-hour full-refund cancellation policy is considered reasonable, but very short windows carry risk before consumer arbitration boards.

## 5. Insurance & Malpractice

- **Public insurance (SGK/Medula):** only contracted providers can access Medula; home consultation billing isn't defined for private platforms. **Recommendation: avoid SGK integration initially; use card payments + private insurance only.**
- **Private insurance:** lower risk — negotiate per-insurer, since each policy must define "home consultation" coverage.
- **Malpractice:** every participating doctor must carry **active mandatory malpractice insurance**, verified by the platform. Under the Code of Obligations the platform could be **jointly liable** for a doctor's error — mitigate by clearly defining the doctor as an independent contractor and the platform as an intermediary in the contracts and T&Cs.

## 6. Contracts to Prepare

Patient platform-use agreement (distance-contract pre-disclosure) · doctor cooperation agreement (independent-contractor, commission, SLA, termination) · KVKK explicit-consent text (separate) · KVKK data-processor agreement · NDAs (doctors & staff) · investor agreements (SHA, vesting, anti-dilution, liquidation preference).

## 7. Labor Law — Worker vs. Independent Contractor

The biggest platform-economy battleground (à la Uber/Getir). A doctor risks being deemed an **employee** if the platform sets hours, removes patient-choice, imposes discipline, is the doctor's only channel, or sets the price. Independent-contractor indicators: doctor chooses hours, may accept/decline patients, may work on multiple platforms, carries own insurance, negotiates price, signs a **service** (not employment) contract. Inspectors apply the "real relationship" test — a label alone won't protect against retroactive social-security premiums, fines and severance exposure.

## 8. Medical Association & Ethics

Self-employed physicians must join the medical chamber, which enforces ethics. **Physician advertising is prohibited** — a "doctor promotion/advertising" revenue line conflicts directly with this. **Recommendation: use a "patient–doctor matching algorithm" framed as information, not advertising; open early dialogue with the medical association** as a partner that expands patient access. Deontology duties at home visits: patient privacy, informed consent, an emergency protocol, and e-prescription access.

## 9. Intellectual Property

- **Trademark:** register "DocDoor" with the patent office across the relevant Nice classes (software, intermediation, technology, health).
- **Software copyright:** protected automatically on creation, but keep timestamped source backups and have employees/freelancers sign **IP-assignment agreements** (otherwise copyright stays with the developer), and verify open-source license compliance.

## 10. Step-by-Step Legal Plan

- **Month 1–2 (pre-formation):** retain health-law counsel; file a written opinion request with the provincial health authority ("is a home-doctor platform legal?"); choose entity; set NACE codes (no health code); file the trademark.
- **Month 2–3 (formation):** trade-registry, tax, e-invoice; VERBİS; KVKK documents; platform & doctor contracts; payment-provider agreement; malpractice-verification procedure.
- **Month 3–6 (launch):** sign only eligible own-practice/private physicians; collect separate KVKK consent; publish cancellation/refund policy; emergency protocol + training; informal medical-chamber dialogue.
- **Month 6–12 (scale prep):** evaluate the Ministry response (pivot if negative); pilot private-insurer agreements; prepare the SHA; plan the LLC→JSC conversion; cybersecurity/KVKK technical audit.

## 11. Legal Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|:----------:|:------:|------------|
| Ministry ban / heavy licensing | ~35% | Existential | Proactive dialogue, counsel, pivot plan |
| Doctor reclassified as employee | ~25% | High | Contract design, independence indicators |
| KVKK data breach | ~20% | High | Technical security, VERBİS, explicit consent |
| Malpractice lawsuit | ~10% | Existential | Insurance verification, quality control |
| Medical-association opposition | ~20% | Medium | Dialogue; "matching" not "advertising" |
| Consumer complaints | ~40% | Low | Transparent cancellation policy, support |
| Payment-licensing issue | ~10% | High | Use a licensed payment institution |
| Trademark/IP infringement | ~15% | Medium | Early registration, prior-art search |
| Tax / social-security audit | ~30% | Medium | Accountant, regular filings |
| Competition law | ~5% | Low | Competitive, transparent pricing |

**Conclusion.** DocDoor faces risk across at least ten areas of Turkish law. The three most critical — **Ministry regulation, KVKK health-data protection, and doctor employment status** — must be managed simultaneously. Specialist counsel is a necessity, not an option; launching without legal foundations risks shutdown at the first serious inspection.
