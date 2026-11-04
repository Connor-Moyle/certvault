"""Builds app/static/icons.svg (a sprite) from the Material Symbols Rounded package.
Usage: npm i @material-symbols/svg-400 && python tools/build_icons.py node_modules/@material-symbols/svg-400/rounded
"""
import re, sys
from pathlib import Path

ICONS = """home home-fill description description-fill settings settings-fill add add_a_photo upload_file
arrow_back edit delete download star_shine star_shine-fill refresh notifications lock logout search close check
warning error schedule event location_on badge person tag calendar_month visibility open_in_new folder_open
pending task_alt hourglass_top key group mail send smart_toy palette dark_mode verified apartment more_vert
history_edu directions_car license construction medical_services ecg_heart stairs_2 emergency sensor_door air
forklift cell_tower traffic electric_bolt local_police family_restroom id_card how_to_reg school anchor
notifications_active shield_lock event_busy event_available photo_camera category
fact_check fact_check-fill inventory_2 table_view list_alt list_alt-fill checklist print electrical_services precision_manufacturing
share flip calendar_add_on folder_zip work autorenew payments sell content_copy check_box check_box_outline_blank select_check_box verified_user deselect person_book
shield health_and_safety umbrella car_crash car_repair minor_crash build_circle business_center handshake contract
assignment_turned_in passport receipt_long speed fire_extinguisher card_membership medical_information hearing home_work
update event_repeat note_add water_drop account_balance factory engineering bolt create_new_folder drive_file_move picture_as_pdf folder_special collections_bookmark checklist_rtl timeline backup settings_backup_restore manage_search android folder_open-fill
""".split()

src = Path(sys.argv[1])
out = ['<svg xmlns="http://www.w3.org/2000/svg">']
for name in ICONS:
    svg = (src / f"{name}.svg").read_text()
    paths = "".join(re.findall(r"<path[^>]*/>", svg))
    out.append(f'<symbol id="{name}" viewBox="0 -960 960 960">{paths}</symbol>')
out.append("</svg>")
Path(__file__).resolve().parent.parent.joinpath("app/static/icons.svg").write_text("\n".join(out))
print(f"{len(ICONS)} icons written")
