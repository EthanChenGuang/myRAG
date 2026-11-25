Labels = dict[str, tuple[str, ...]]

FIELD_LABELS: dict[str, Labels] = {
    "invoice_number": {
        "zh": ("发票号码", "发票号", "发票编号", "票据号码"),
        "en": ("Invoice number", "Invoice no", "Invoice #", "Invoice nr", "Invoice ID", "Inv no", "Document number", "Document no"),
        "it": ("Numero fattura", "Fattura numero", "Fattura n", "Fattura nr", "N fattura", "Nr fattura", "Numero documento", "Documento n"),
    },
    "issue_date": {
        "zh": ("开票日期", "发票日期", "日期"),
        "en": ("Invoice date", "Date of issue", "Issue date", "Date issued", "Issued", "Date"),
        "it": ("Data fattura", "Data emissione", "Data di emissione", "Data documento", "Data"),
    },
    "due_date": {
        "zh": ("到期日期", "到期日", "付款期限", "付款截止日期"),
        "en": ("Due date", "Payment due date", "Payment due", "Date due", "Pay by", "Due"),
        "it": ("Data scadenza", "Data di scadenza", "Scadenza pagamento", "Pagamento entro", "Scadenza"),
    },
    "supplier": {
        "zh": ("销售方", "销方", "卖方", "收款方", "开票方", "销货单位", "销售单位"),
        "en": ("Supplier", "Seller", "Vendor", "Issued by", "Sold by", "From"),
        "it": ("Cedente/Prestatore", "Cedente", "Prestatore", "Fornitore", "Emittente", "Venditore"),
    },
    "buyer": {
        "zh": ("购买方", "购方", "买方", "购货单位", "付款方"),
        "en": ("Bill to", "Billed to", "Invoice to", "Sold to", "Buyer", "Customer", "Client"),
        "it": ("Cessionario/Committente", "Cessionario", "Committente", "Cliente", "Destinatario", "Acquirente", "Intestatario"),
    },
    "party_name": {
        "zh": ("公司名称", "单位名称", "名称"),
        "en": ("Company name", "Business name", "Company", "Name"),
        "it": ("Ragione sociale", "Denominazione", "Società", "Nome"),
    },
    "party_tax_id": {
        "zh": ("纳税人识别号/统一社会信用代码", "纳税人识别号", "纳税人识别码", "统一社会信用代码", "税号", "识别号"),
        "en": (
            "VAT registration number", "VAT reg no", "VAT number", "VAT no", "VAT ID",
            "Tax registration number", "Tax number", "Tax no", "Tax ID",
        ),
        "it": ("Partita IVA", "P.IVA", "P. IVA", "P.I.V.A", "PIVA"),
    },
    "net_total": {
        "zh": ("合计金额", "不含税金额", "金额合计", "不含税合计", "不含税总额", "小计"),
        "en": (
            "Subtotal", "Sub-total", "Net total", "Net amount", "Total net", "Taxable amount",
            "Total excl VAT", "Total excluding VAT", "Amount excl VAT",
        ),
        "it": ("Totale imponibile", "Importo imponibile", "Base imponibile", "Totale netto", "Imponibile", "Netto"),
    },
    "tax_total": {
        "zh": ("合计税额", "税额合计", "增值税额", "税额", "税金"),
        "en": ("Total VAT", "Total tax", "VAT amount", "Tax amount", "Sales tax", "VAT", "Tax"),
        "it": ("Totale IVA", "Importo IVA", "Imposta", "IVA"),
    },
    "gross_total": {
        "zh": ("价税合计", "含税合计", "含税金额", "应付金额", "总金额", "金额总计", "总计"),
        "en": (
            "Total incl VAT", "Total including VAT", "Total gross", "Total payable", "Total to pay", "Total amount",
            "Total due", "Grand total", "Amount due", "Balance due", "Total",
        ),
        "it": (
            "Totale documento", "Totale fattura", "Totale complessivo", "Totale da pagare", "Totale dovuto",
            "Importo totale", "Netto a pagare", "Totale",
        ),
    },
}

COLUMN_LABELS: dict[str, Labels] = {
    "tax_amount": {
        "zh": ("税额",),
        "en": ("Tax amount", "VAT amount"),
        "it": ("Importo IVA",),
    },
    "tax_rate": {
        "zh": ("税率/征收率", "税率"),
        "en": ("Tax rate", "VAT rate", "VAT %", "VAT%", "Tax %"),
        "it": ("Aliquota IVA", "Aliquota", "IVA %", "% IVA"),
    },
    "unit_price": {
        "zh": ("单价",),
        "en": ("Unit price", "Price"),
        "it": ("Prezzo unitario", "Prezzo"),
    },
    "quantity": {
        "zh": ("数量",),
        "en": ("Quantity", "Qty"),
        "it": ("Quantità", "Qtà", "Qta"),
    },
    "amount": {
        "zh": ("金额",),
        "en": ("Line total", "Amount", "Total"),
        "it": ("Importo", "Totale"),
    },
    "description": {
        "zh": ("货物或应税劳务、服务名称", "项目名称", "商品名称", "货物名称", "品名", "名称"),
        "en": ("Description", "Product", "Item"),
        "it": ("Descrizione", "Articolo", "Prodotto"),
    },
}

TOTAL_ROW_LABELS: tuple[str, ...] = ("合计", "总计", "小计", "Total", "Subtotal", "Totale", "Totali")
