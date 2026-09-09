"""Invented vendors. Each one fixes a layout template and a regional
convention set (currency, number format, date format, numbering scheme,
tax label and rate), because a real vendor never changes those between
invoices and a reconciler has to cope with all of them side by side.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Vendor:
    name: str
    template: str          # file in sample_gen/templates
    country: str
    currency: str          # ISO code
    symbol: str            # what the invoice prints, may equal the code
    number_format: str     # "us" 1,234.56 | "eu" 1.234,56 | "plain" 1234.56
    date_format: str       # strftime
    numbering: str         # format() pattern with {n}
    tax_label: str
    tax_rate: float
    address: str
    tax_id_label: str
    tax_id: str
    payment_note: str
    services: tuple[str, ...]


VENDORS: list[Vendor] = [
    Vendor("Bluefern Supplies Ltd", "uk_service.html", "GB", "GBP", "£", "us", "%d/%m/%Y", "BF-{n:05d}",
           "VAT 20%", 0.20, "14 Tanner Row, York YO1 6JB", "VAT Reg No", "GB 482 7191 44",
           "Bank transfer to Bluefern Supplies Ltd, sort code 40-11-02, account 31446291",
           ("Office consumables, monthly", "Toner cartridges, pack of 4", "Copy paper A4 80gsm, 20 reams",
            "Archive boxes, 25 units", "Label printer tape, 6 rolls")),
    Vendor("Nordway Logistics", "us_letter.html", "US", "USD", "$", "us", "%m/%d/%Y", "NW-{n}",
           "Sales tax", 0.0, "1220 Harbor Rd, Suite 4, Portland, OR 97209", "EIN", "84-3311902",
           "ACH: routing 123006800, account 559120044. Net 30.",
           ("Freight, regional route", "Pallet handling", "Fuel surcharge", "Warehouse storage, per week",
            "Cross-dock transfer")),
    Vendor("Cedar & Finch Consulting", "minimal_freelancer.html", "US", "USD", "$", "us", "%B %d, %Y", "CF-2025-{n:03d}",
           "Tax", 0.0, "88 Alder St, Boulder, CO 80302", "EIN", "47-2209918",
           "Please pay by wire within 14 days.",
           ("Process review, days", "Workshop facilitation", "Report drafting", "Follow-up call")),
    Vendor("Pinehollow Office Co", "grid_einvoice.html", "DE", "EUR", "€", "eu", "%d.%m.%Y", "PH/2025/{n:04d}",
           "MwSt. 19%", 0.19, "Lindenstraße 27, 10969 Berlin", "USt-IdNr.", "DE 311 908 274",
           "IBAN DE44 5001 0517 5407 3249 31 · BIC INGDDEFFXXX",
           ("Bürostuhl ergonomisch", "Schreibtisch höhenverstellbar", "Monitorarm", "Aktenschrank 4OH",
            "Montage und Lieferung")),
    Vendor("Meridian Print Services", "uk_service.html", "GB", "GBP", "£", "us", "%d %B %Y", "MPS{n:06d}",
           "VAT 20%", 0.20, "Unit 9, Cobalt Business Park, Newcastle NE27 0QJ", "VAT Reg No", "GB 903 2287 15",
           "BACS to Meridian Print Services Ltd, sort code 20-59-42, account 70882913",
           ("Brochures A5, 500 copies", "Business cards, 250", "Roller banner 850mm", "Letterheads, 1000",
            "Design amends, hours")),
    Vendor("Amberlake Facilities", "statement.html", "AU", "AUD", "$", "us", "%d/%m/%Y", "AF-{n:05d}",
           "GST 10%", 0.10, "Level 3, 41 Exhibition St, Melbourne VIC 3000", "ABN", "51 824 753 556",
           "Direct deposit: BSB 083-004, Acc 12 776 4410",
           ("Cleaning, weekly", "Waste collection", "HVAC filter service", "Grounds maintenance",
            "Security patrol, nights")),
    Vendor("Halden & Roux Avocats", "grid_einvoice.html", "FR", "EUR", "€", "eu", "%d/%m/%Y", "HR-{n:04d}",
           "TVA 20%", 0.20, "12 rue de Turbigo, 75002 Paris", "N° TVA", "FR 76 512 380 419",
           "IBAN FR76 3000 6000 0112 3456 7890 189",
           ("Consultation juridique", "Rédaction de contrat", "Revue de conformité", "Honoraires forfaitaires")),
    Vendor("Karadut Yazılım A.Ş.", "grid_einvoice.html", "TR", "TRY", "₺", "eu", "%d.%m.%Y", "KDY2025{n:09d}",
           "KDV %20", 0.20, "Maslak Mah. Büyükdere Cad. No:255 Sarıyer / İstanbul", "VKN", "5120398761",
           "IBAN TR33 0006 1005 1978 6457 8413 26",
           ("Yazılım bakım hizmeti", "Sunucu barındırma", "Lisans yenileme", "Danışmanlık, saat")),
    Vendor("Saltmarsh Coffee Roasters", "thermal_receipt.html", "US", "USD", "$", "plain", "%m/%d/%y", "{n}",
           "Tax 8.875%", 0.08875, "203 Water St, Brooklyn, NY 11201", "", "",
           "Thank you!",
           ("Espresso blend 1kg", "Single origin 250g", "Oat milk case", "Filter papers", "Cold brew 5L")),
    Vendor("Tidewell Insurance Brokers", "us_letter.html", "US", "USD", "$", "us", "%b %d, %Y", "TIB-{n:07d}",
           "Tax", 0.0, "700 Commerce Dr, Suite 210, Austin, TX 78701", "EIN", "26-1187734",
           "Remit to lockbox PO Box 91123, Austin TX 78709",
           ("General liability premium", "Property coverage", "Broker fee", "Policy endorsement")),
    Vendor("Orrin Bakke Elektro AS", "minimal_freelancer.html", "NO", "EUR", "€", "eu", "%d.%m.%Y", "{n}",
           "MVA 25%", 0.25, "Storgata 14, 0155 Oslo", "Org.nr", "NO 918 322 109 MVA",
           "Kontonr 1503.44.21099",
           ("Elektroinstallasjon, timer", "Materiell", "Kjøring")),
    Vendor("Wrenfield Software Ltd", "uk_service.html", "GB", "GBP", "£", "us", "%Y-%m-%d", "WS-{n:04d}",
           "VAT 20%", 0.20, "Studio 2, 19 Rivington St, London EC2A 3DT", "VAT Reg No", "GB 771 4025 08",
           "Payment by Faster Payments, sort code 04-00-04, account 21998730",
           ("Subscription, monthly", "Additional seats", "Onboarding session", "Priority support")),
]

BUYER = {
    "name": "Harrowgate Trading Co.",
    "address": "Suite 12, 45 Quayside, Bristol BS1 4TR",
    "contact": "accounts@harrowgate-trading.example",
}
