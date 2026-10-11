package contentcatalog

// countryTable 来自 packages/utils/src/country-data.ts，顺序与 Nest 构建 alpha2/alpha3 映射一致（后写覆盖先写）。
const countryTable = `
Andorra|AD|AND
United Arab Emirates|AE|ARE
Afghanistan|AF|AFG
Antigua And Barbuda|AG|ATG
Anguilla|AI|AIA
French Afar and Issas|AI|AFI
Albania|AL|ALB
Armenia|AM|ARM
Netherlands Antilles|AN|ANT
Angola|AO|AGO
Antarctica|AQ|ATA
Argentina|AR|ARG
American Samoa|AS|ASM
Austria|AT|AUT
Australia|AU|AUS
Aruba|AW|ABW
Aland Islands|AX|ALA
Azerbaijan|AZ|AZE
Bosnia & Herzegovina|BA|BIH
Barbados|BB|BRB
Bangladesh|BD|BGD
Belgium|BE|BEL
Burkina Faso|BF|BFA
Bulgaria|BG|BGR
Bahrain|BH|BHR
Burundi|BI|BDI
Benin|BJ|BEN
Saint Barthelemy|BL|BLM
Bermuda|BM|BMU
Brunei Darussalam|BN|BRN
Bolivia, Plurinational State Of|BO|BOL
Bonaire, Saint Eustatius And Saba|BQ|BES
British Antarctic Territory|BQ|ATB
Brazil|BR|BRA
Bahamas|BS|BHS
Bhutan|BT|BTN
Burma|BU|BUR
Bouvet Island|BV|BVT
Botswana|BW|BWA
Belarus|BY|BLR
Byelorussian SSR|BY|BYS
Belize|BZ|BLZ
Canada|CA|CAN
Cocos (Keeling) Islands|CC|CCK
Democratic Republic Of Congo|CD|COD
Central African Republic|CF|CAF
Republic Of Congo|CG|COG
Switzerland|CH|CHE
Cote d'Ivoire|CI|CIV
Cook Islands|CK|COK
Chile|CL|CHL
Cameroon|CM|CMR
China|CN|CHN
Colombia|CO|COL
Costa Rica|CR|CRI
Czechoslovakia|CS|CSK
Serbia and Montenegro|CS|SCG
Canton and Enderbury Islands|CT|CTE
Cuba|CU|CUB
Cabo Verde|CV|CPV
Curacao|CW|CUW
Christmas Island|CX|CXR
Cyprus|CY|CYP
Czech Republic|CZ|CZE
German Democratic Republic|DD|DDR
Germany|DE|DEU
Djibouti|DJ|DJI
Denmark|DK|DNK
Dominica|DM|DMA
Dominican Republic|DO|DOM
Dahomey|DY|DHY
Algeria|DZ|DZA
Ecuador|EC|ECU
Estonia|EE|EST
Egypt|EG|EGY
Western Sahara|EH|ESH
Eritrea|ER|ERI
Spain|ES|ESP
Ethiopia|ET|ETH
Finland|FI|FIN
Fiji|FJ|FJI
Falkland Islands|FK|FLK
Micronesia, Federated States Of|FM|FSM
Faroe Islands|FO|FRO
French Southern and Antarctic Territories|FQ|ATF
France|FR|FRA
Gabon|GA|GAB
United Kingdom|GB|GBR
Grenada|GD|GRD
Georgia|GE|GEO
Gilbert and Ellice Islands|GE|GEL
French Guiana|GF|GUF
Guernsey|GG|GGY
Ghana|GH|GHA
Gibraltar|GI|GIB
Greenland|GL|GRL
Gambia|GM|GMB
Guinea|GN|GIN
Guadeloupe|GP|GLP
Equatorial Guinea|GQ|GNQ
Greece|GR|GRC
South Georgia And The South Sandwich Islands|GS|SGS
Guatemala|GT|GTM
Guam|GU|GUM
Guinea-bissau|GW|GNB
Guyana|GY|GUY
Hong Kong|HK|HKG
Heard Island And McDonald Islands|HM|HMD
Honduras|HN|HND
Croatia|HR|HRV
Haiti|HT|HTI
Hungary|HU|HUN
Upper Volta|HV|HVO
Indonesia|ID|IDN
Ireland|IE|IRL
Israel|IL|ISR
Isle Of Man|IM|IMN
India|IN|IND
British Indian Ocean Territory|IO|IOT
Iraq|IQ|IRQ
Iran, Islamic Republic Of|IR|IRN
Iceland|IS|ISL
Italy|IT|ITA
Jersey|JE|JEY
Jamaica|JM|JAM
Jordan|JO|JOR
Japan|JP|JPN
Johnston Island|JT|JTN
Kenya|KE|KEN
Kyrgyzstan|KG|KGZ
Cambodia|KH|KHM
Kiribati|KI|KIR
Comoros|KM|COM
Saint Kitts And Nevis|KN|KNA
Korea, Democratic People's Republic Of|KP|PRK
Korea, Republic Of|KR|KOR
Kuwait|KW|KWT
Cayman Islands|KY|CYM
Kazakhstan|KZ|KAZ
Lao People's Democratic Republic|LA|LAO
Lebanon|LB|LBN
Saint Lucia|LC|LCA
Liechtenstein|LI|LIE
Sri Lanka|LK|LKA
Liberia|LR|LBR
Lesotho|LS|LSO
Lithuania|LT|LTU
Luxembourg|LU|LUX
Latvia|LV|LVA
Libya|LY|LBY
Morocco|MA|MAR
Monaco|MC|MCO
Moldova|MD|MDA
Montenegro|ME|MNE
Saint Martin|MF|MAF
Madagascar|MG|MDG
Marshall Islands|MH|MHL
Midway Islands|MI|MID
Macedonia, The Former Yugoslav Republic Of|MK|MKD
Mali|ML|MLI
Myanmar|MM|MMR
Mongolia|MN|MNG
Macao|MO|MAC
Northern Mariana Islands|MP|MNP
Martinique|MQ|MTQ
Mauritania|MR|MRT
Montserrat|MS|MSR
Malta|MT|MLT
Mauritius|MU|MUS
Maldives|MV|MDV
Malawi|MW|MWI
Mexico|MX|MEX
Malaysia|MY|MYS
Mozambique|MZ|MOZ
Namibia|NA|NAM
New Caledonia|NC|NCL
Niger|NE|NER
Norfolk Island|NF|NFK
Nigeria|NG|NGA
New Hebrides|NH|NHB
Nicaragua|NI|NIC
Netherlands|NL|NLD
Norway|NO|NOR
Nepal|NP|NPL
Dronning Maud Land|NQ|ATN
Nauru|NR|NRU
Neutral Zone|NT|NTZ
Niue|NU|NIU
New Zealand|NZ|NZL
Oman|OM|OMN
Panama|PA|PAN
Pacific Islands, Trust Territory of the|PC|PCI
Peru|PE|PER
French Polynesia|PF|PYF
Papua New Guinea|PG|PNG
Philippines|PH|PHL
Pakistan|PK|PAK
Poland|PL|POL
Saint Pierre And Miquelon|PM|SPM
Pitcairn|PN|PCN
Puerto Rico|PR|PRI
Palestinian Territory, Occupied|PS|PSE
Portugal|PT|PRT
U.S. Miscellaneous Pacific Islands|PU|PUS
Palau|PW|PLW
Paraguay|PY|PRY
Panama Canal Zone|PZ|PCZ
Qatar|QA|QAT
Reunion|RE|REU
Southern Rhodesia|RH|RHO
Romania|RO|ROU
Serbia|RS|SRB
Russian Federation|RU|RUS
Rwanda|RW|RWA
Saudi Arabia|SA|SAU
Solomon Islands|SB|SLB
Seychelles|SC|SYC
Sudan|SD|SDN
Sweden|SE|SWE
Singapore|SG|SGP
Saint Helena, Ascension And Tristan Da Cunha|SH|SHN
Slovenia|SI|SVN
Svalbard And Jan Mayen|SJ|SJM
Slovakia|SK|SVK
Sikkim|SK|SKM
Sierra Leone|SL|SLE
San Marino|SM|SMR
Senegal|SN|SEN
Somalia|SO|SOM
Suriname|SR|SUR
South Sudan|SS|SSD
Sao Tome and Principe|ST|STP
El Salvador|SV|SLV
Sint Maarten|SX|SXM
Syrian Arab Republic|SY|SYR
Swaziland|SZ|SWZ
Turks And Caicos Islands|TC|TCA
Chad|TD|TCD
French Southern Territories|TF|ATF
Togo|TG|TGO
Thailand|TH|THA
Tajikistan|TJ|TJK
Tokelau|TK|TKL
Timor-Leste, Democratic Republic of|TL|TLS
Turkmenistan|TM|TKM
Tunisia|TN|TUN
Tonga|TO|TON
East Timor|TP|TMP
Turkey|TR|TUR
Trinidad And Tobago|TT|TTO
Tuvalu|TV|TUV
Taiwan|TW|TWN
Tanzania, United Republic Of|TZ|TZA
Ukraine|UA|UKR
Uganda|UG|UGA
United States Minor Outlying Islands|UM|UMI
United States|US|USA
Uruguay|UY|URY
Uzbekistan|UZ|UZB
Vatican City State|VA|VAT
Saint Vincent And The Grenadines|VC|VCT
Viet-Nam, Democratic Republic of|VD|VDR
Venezuela, Bolivarian Republic Of|VE|VEN
Virgin Islands (British)|VG|VGB
Virgin Islands (US)|VI|VIR
Viet Nam|VN|VNM
Vanuatu|VU|VUT
Wallis And Futuna|WF|WLF
Wake Island|WK|WAK
Samoa|WS|WSM
Yemen, Democratic|YD|YMD
Yemen|YE|YEM
Mayotte|YT|MYT
Yugoslavia|YU|YUG
South Africa|ZA|ZAF
Zambia|ZM|ZMB
Zaire|ZR|ZAR
Zimbabwe|ZW|ZWE
`
