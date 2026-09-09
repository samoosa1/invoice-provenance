# Copied from ledger-reconciler (same author, MIT). Extended here to emit field-level ground truth.
"""Synthetic sample-data generator: invented vendors, six invoice layouts
rendered from HTML through headless Chromium, a scan-artefact pass, and a
ledger export with realistic reconciliation faults planted in it.

Layouts follow conventions that are public knowledge about how invoices
and bank receipts are laid out in different regions. No real company,
person, document or transaction appears anywhere in the output.
"""
