"""Read Office XML text from a user-selected attachment without extracting files."""
import re
import sys
import zipfile
from xml.etree import ElementTree as ET


def text(node):
    return "".join(n.text or "" for n in node.iter() if n.tag.rsplit("}", 1)[-1] == "t")


with zipfile.ZipFile(sys.argv[1]) as archive:
    budget = 24 * 1024 * 1024

    def read(name):
        global budget
        budget -= archive.getinfo(name).file_size
        if budget < 0:
            raise ValueError("Document too large")
        return ET.fromstring(archive.read(name))

    names = archive.namelist()
    if "word/document.xml" in names:
        for p in read("word/document.xml").iterfind(".//{*}p"):
            print(text(p))
    elif "xl/workbook.xml" in names:
        strings = [text(s) for s in read("xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in names else []
        for sheet in sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)):
            print(sheet)
            for row in read(sheet).iterfind(".//{*}row"):
                values = []
                for cell in row.iterfind("{*}c"):
                    value = cell.findtext("{*}v", "") or text(cell)
                    if cell.get("t") == "s":
                        value = strings[int(value)]
                    values.append(cell.get("r", "") + "=" + value)
                print("\t".join(values))
    else:
        for slide in sorted(n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)):
            print(slide, text(read(slide)), sep="\n")
