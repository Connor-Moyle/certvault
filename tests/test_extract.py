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
