from datetime import date
from app.extract import rule_extract, classify_dates

TODAY = date(2026, 11, 4)

def test_first_aid_soa():
    t = """Allens Training Pty Ltd  RTO No: 90909
    STATEMENT OF ATTAINMENT
    This is to certify that
    CONNOR MOYLE
    has attained HLTAID011 Provide First Aid
    Date of completion: 14/03/2025
    Venue: Osborne Park WA 6017"""
    r = rule_extract(t, TODAY)
    assert r["category"] == "first_aid"
    assert r["completion_date"] == "2025-03-14"
    assert r["expiry_date"] == "2028-03-14" and r["expiry_estimated"]
    assert r["holder_name"] == "Connor Moyle"
    assert "Osborne Park" in r["location"]
    assert r["title"].startswith("HLTAID011")

def test_drivers_licence():
    t = """WESTERN AUSTRALIA DRIVER'S LICENCE
    Licence No. 1234567  Class C
    Date of Birth 02/05/1999
    Expiry 12 JUN 2029"""
    r = rule_extract(t, TODAY)
    assert r["category"] == "drivers_licence"
    assert r["expiry_date"] == "2029-06-12"
    assert r["issuer"] == "WA Department of Transport"
    assert r["completion_date"] is None  # DOB ignored

def test_valid_from_to():
    d = classify_dates("Site induction valid from 01/02/2026 to 01/02/2027", TODAY)
    assert d["completion_date"] == date(2026, 2, 1)
    assert d["expiry_date"] == date(2027, 2, 1)

def test_month_year_expiry():
    d = classify_dates("Issued 3 Jan 2024  Expires: Mar 2027", TODAY)
    assert d["expiry_date"] == date(2027, 3, 31)
    assert d["completion_date"] == date(2024, 1, 3)

def test_ocr_letter_o_in_codes():
    r = rule_extract("STATEMENT OF ATTAINMENT\nhas attained the following unit of competency\nHLTAIDO11 Provide First Aid\nDate of completion: 12/11/2023\nDelivered at Kewdale WA 6105", TODAY)
    assert r["category"] == "first_aid"
    assert r["title"] == "HLTAID011 Provide First Aid"
    assert r["location"] == "Kewdale WA 6105"

def test_rigging_register_spreadsheet(tmp_path):
    from openpyxl import Workbook
    from datetime import datetime
    from app.extract import sniff, spreadsheet_text
    wb = Workbook(); ws = wb.active; ws.title = "Rigging Gear"
    ws.append(["Item", "WLL", "Serial", "Last inspection", "Next inspection due", "Colour code"])
    ws.append(["Round sling 2t", "2t", "RS-001", datetime(2026, 9, 1), datetime(2026, 12, 1), "Green"])
    ws.append(["Bow shackle 3.25t", "3.25t", "SH-014", datetime(2026, 9, 1), datetime(2026, 11, 20), "Green"])
    ws.append(["Chain block 1t", "1t", "CB-003", datetime(2026, 6, 1), datetime(2027, 6, 1), "Green"])
    p = tmp_path / "gear.xlsx"; wb.save(p)
    data = p.read_bytes()
    assert sniff(data[:16], data, "gear.xlsx")[0] == "xlsx"
    r = rule_extract(spreadsheet_text(p, "xlsx"), TODAY)
    assert r["category"] == "rigging_register"
    assert r["expiry_date"] == "2026-11-20"   # earliest upcoming due item
    assert r["completion_date"] == "2026-09-01"

def test_csv_sniff():
    from app.extract import sniff
    data = b"Item,Tested,Next test due\nDrill,01/09/2026,01/12/2026\n"
    assert sniff(data[:16], data, "test-tag.csv") == ("csv", "text/csv")
    assert sniff(data[:16], data, "notes.txt") is None

def test_hrwl_classes():
    t = """WorkSafe Western Australia
    LICENCE TO PERFORM HIGH RISK WORK
    Licence No. HRW123456  Expiry 04/03/2030
    Classes: CV DG RB WP"""
    r = rule_extract(t, TODAY)
    assert r["category"] == "hrwl"
    assert "CV – Vehicle loading crane" in r["classes"]
    assert "DG – Dogging" in r["classes"] and "RB – Basic rigging" in r["classes"] and r["classes"].count("–") == 4
    assert r["expiry_date"] == "2030-03-04"

def test_driver_classes():
    r = rule_extract("WESTERN AUSTRALIA DRIVER'S LICENCE\nClass: C, HR\nExpiry 12 JUN 2029", TODAY)
    assert r["classes"].startswith("C – Car") and "HR – Heavy rigid" in r["classes"]
